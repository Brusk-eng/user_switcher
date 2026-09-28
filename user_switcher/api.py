import re

import frappe
from frappe import _
from frappe.sessions import delete_session
from frappe.utils import escape_html, validate_email_address

ALLOWED_ROLES = {"System Manager"}
AUTOMATIC_ROLES = ["All", "Guest", "Administrator", "Desk User"]


def _real_user() -> str:
	"""The user who actually logged in, even while switched into someone else."""
	return frappe.session.data.get("impersonated_by") or frappe.session.user


def _is_enabled() -> bool:
	return bool(frappe.conf.developer_mode or frappe.conf.get("user_switcher_enabled"))


def _can_switch(real_user: str | None = None) -> bool:
	real_user = real_user or _real_user()
	if real_user == "Guest" or not _is_enabled():
		return False
	if real_user == "Administrator":
		return True
	return bool(ALLOWED_ROLES & set(frappe.get_roles(real_user)))


@frappe.whitelist()
def get_context(txt: str | None = None, user_type: str | None = None, limit: int = 30):
	"""Return switcher state + a user list. Never throws for unauthorised users, just says no."""
	real_user = _real_user()
	if not _can_switch(real_user):
		return {"allowed": False}

	limit = min(int(limit), 100)
	if not limit:
		return {"allowed": True}

	users = _find_users(real_user, txt, user_type, limit)

	return {
		"allowed": True,
		"real_user": _user_info(real_user),
		"current_user": _user_info(frappe.session.user),
		"is_switched": real_user != frappe.session.user,
		"users": users,
	}


def _find_users(real_user: str, txt: str | None, user_type: str | None, limit: int) -> list[dict]:
	filters = {"enabled": 1, "name": ["not in", ["Guest", frappe.session.user]]}
	if real_user != "Administrator":
		# A System Manager must not escalate to Administrator
		filters["name"][1].append("Administrator")

	if user_type in ("System User", "Website User"):
		filters["user_type"] = user_type

	or_filters = None
	if txt:
		or_filters = {"name": ["like", f"%{txt}%"], "full_name": ["like", f"%{txt}%"]}

	users = frappe.get_all(
		"User",
		filters=filters,
		or_filters=or_filters,
		fields=["name", "full_name", "user_image", "user_type"],
		order_by="last_active desc",
		limit=limit,
		ignore_permissions=True,
	)
	_attach_roles(users)
	return users


def _user_info(user: str) -> dict:
	info = frappe.db.get_value("User", user, ["name", "full_name", "user_image", "user_type"], as_dict=True)
	return info or {"name": user}


def _attach_roles(users: list[dict]) -> None:
	"""Add each user's roles (minus the automatic ones), so the UI can hint at who is who."""
	if not users:
		return
	rows = frappe.get_all(
		"Has Role",
		filters={
			"parenttype": "User",
			"parent": ["in", [u.name for u in users]],
			"role": ["not in", AUTOMATIC_ROLES],
		},
		fields=["parent", "role"],
		order_by="role asc",
		ignore_permissions=True,
	)
	roles_by_user = {}
	for row in rows:
		roles_by_user.setdefault(row.parent, []).append(row.role)
	for u in users:
		u["roles"] = roles_by_user.get(u.name, [])


@frappe.whitelist(methods=["POST"])
def switch_to_user(target_user: str):
	real_user = _real_user()
	if not _can_switch(real_user):
		frappe.throw(_("Not permitted to switch users"), frappe.PermissionError)

	if target_user == "Guest" or not frappe.db.get_value("User", target_user, "enabled"):
		frappe.throw(_("User {0} does not exist or is disabled").format(target_user))

	if target_user == "Administrator" and real_user != "Administrator":
		frappe.throw(_("Only Administrator can switch into Administrator"), frappe.PermissionError)

	if target_user == frappe.session.user:
		return {"current_user": target_user}

	old_sid = frappe.session.sid
	session_data = frappe.local.session_obj.data.data
	login_manager = frappe.local.login_manager

	# login_as() creates a brand new session and sets the sid cookie, so the switch
	# survives the reload (frappe.set_user() only affects the current request).
	login_manager.login_as(
		target_user, session_end=session_data.session_end, audit_user=session_data.audit_user
	)

	if target_user != real_user:
		# Keeps the "impersonating" banner in desk, tags Version logs, and lets us switch back.
		frappe.local.session_obj.set_impersonated(real_user)

	delete_session(old_sid, reason="Switched user via User Switcher")

	frappe.get_doc(
		{
			"doctype": "Activity Log",
			"user": target_user,
			"status": "Success",
			"operation": "Impersonate",
			"subject": _("{0} switched to {1} via User Switcher").format(real_user, target_user)
			if target_user != real_user
			else _("{0} switched back to own account via User Switcher").format(real_user),
		}
	).insert(ignore_permissions=True, ignore_links=True)

	return {"current_user": target_user}


@frappe.whitelist(methods=["POST"])
def switch_back():
	return switch_to_user(_real_user())


@frappe.whitelist()
def get_assignable_roles():
	"""Roles offered when creating a test user. `desk_access` decides System vs Website user."""
	if not _can_switch():
		frappe.throw(_("Not permitted"), frappe.PermissionError)
	return frappe.get_all(
		"Role",
		filters={"disabled": 0, "name": ["not in", AUTOMATIC_ROLES]},
		fields=["name", "desk_access"],
		order_by="name asc",
		ignore_permissions=True,
	)


@frappe.whitelist(methods=["POST"])
def create_test_user(full_name: str, email: str, roles: list | str | None = None, switch: int = 1):
	real_user = _real_user()
	if not _can_switch(real_user):
		frappe.throw(_("Not permitted to create test users"), frappe.PermissionError)

	full_name = (full_name or "").strip()
	email = (email or "").strip().lower()
	if not full_name:
		frappe.throw(_("Name is required"))
	validate_email_address(email, throw=True)
	if frappe.db.exists("User", email):
		frappe.throw(_("User {0} already exists").format(email), frappe.DuplicateEntryError)

	roles = frappe.parse_json(roles) if isinstance(roles, str) else (roles or [])
	valid_roles = set(
		frappe.get_all("Role", filters={"name": ["in", roles or [""]], "disabled": 0}, pluck="name")
	) - set(AUTOMATIC_ROLES)

	first_name, _sep, last_name = full_name.partition(" ")
	user = frappe.new_doc("User")
	user.update(
		{
			"email": email,
			"first_name": first_name,
			"last_name": last_name,
			"enabled": 1,
			"send_welcome_email": 0,
			"bio": _("Test user created with User Switcher by {0}").format(real_user),
		}
	)
	for role in sorted(valid_roles):
		user.append("roles", {"role": role})
	user.flags.no_welcome_mail = True
	# The switcher is already restricted to System Managers, who can create users anyway
	user.insert(ignore_permissions=True)

	if int(switch):
		switch_to_user(user.name)

	return {"name": user.name, "full_name": user.full_name, "user_type": user.user_type, "roles": sorted(valid_roles)}


SWITCH_PREFIX = re.compile(r"^(?:switch(?:\s+to)?|su|login\s+as|impersonate)\b\s*(.*)$", re.IGNORECASE)


def awesomebar_search(txt: str) -> list[dict]:
	"""`awesomebar_search` hook: "switch jane" / "su jane" in Ctrl+K switches user."""
	real_user = _real_user()
	if not _can_switch(real_user):
		return []

	match = SWITCH_PREFIX.match(txt.strip())
	if match:
		query, index = match.group(1).strip(), 150
	elif len(txt.strip()) >= 3:
		# Plain name searches still offer a switch, but below Frappe's own results
		query, index = txt.strip(), 5
	else:
		return []

	results = []
	if match and real_user != frappe.session.user and (not query or query.lower() in "back"):
		results.append(
			{
				"label": _("Switch back to {0}").format(
					escape_html(frappe.db.get_value("User", real_user, "full_name") or real_user)
				),
				"value": f"switch-user:{real_user}",
				"description": real_user,
				"route": ["user-switch", real_user],
				"route_options": {"from_awesomebar": 1},
				"index": index + 1,
			}
		)

	for u in _find_users(real_user, query, None, 8 if match else 3):
		roles = ", ".join(u.roles[:3])
		results.append(
			{
				"label": _("Switch to {0}").format(escape_html(u.full_name or u.name)),
				"value": f"switch-user:{u.name}",
				"description": escape_html(u.name + (f" · {roles}" if roles else "")),
				"route": ["user-switch", u.name],
				"route_options": {"from_awesomebar": 1},
				"index": index,
			}
		)
	return results
