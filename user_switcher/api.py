# * user_switcher/api.py

import frappe
from frappe import _
from frappe.sessions import delete_session
from frappe.utils import validate_email_address

ALLOWED_ROLES = {"System Manager"}
AUTOMATIC_ROLES = ["All", "Guest", "Administrator", "Desk User"]


def _real_user() -> str:
	"""The user who actually logged in, even while switched into someone else."""
	return frappe.session.data.get("impersonated_by") or frappe.session.user


def _is_enabled() -> bool:
	# ? NEEDS BOTH SETTINGS: developer_mode ALONE IS OFTEN ON BY HABIT (OR BY MISTAKE ON A LIVE SITE)
	return bool(frappe.conf.developer_mode and frappe.conf.get("user_switcher_enabled"))


def _escape_like(txt: str) -> str:
	"""Escape `\\`, `%` and `_` so user text matches literally inside a LIKE filter."""
	return txt.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _blocked_targets(real_user: str) -> list[str]:
	"""Users `real_user` may not switch into.

	Administrator is blocked for everyone else. Other System Managers are blocked unless
	`real_user` created them and they have no password yet (i.e. they are still test users).
	"""
	if real_user == "Administrator":
		return []

	managers = frappe.get_all(
		"Has Role", filters={"parenttype": "User", "role": "System Manager"}, pluck="parent", ignore_permissions=True
	)
	managers = [m for m in managers if m != real_user]
	if not managers:
		return ["Administrator"]

	owned = frappe.get_all(
		"User", filters={"name": ["in", managers], "owner": real_user}, pluck="name", ignore_permissions=True
	)
	# ? __Auth IS NOT A DOCTYPE, SO frappe.get_all CANNOT READ IT
	with_password = frappe.db.sql_list(
		"select name from __Auth where doctype = 'User' and fieldname = 'password' and name in %s",
		(tuple(owned) or ("",),),
	)
	allowed = set(owned) - set(with_password)
	return ["Administrator", *(m for m in managers if m not in allowed)]


def _can_switch(real_user: str | None = None) -> bool:
	real_user = real_user or _real_user()
	if real_user == "Guest" or not _is_enabled():
		return False
	if not frappe.get_cached_value("User", real_user, "enabled"):
		return False
	if real_user == "Administrator":
		return True
	return bool(ALLOWED_ROLES & set(frappe.get_roles(real_user)))


def _deny(message: str, action: str, target: str | None = None) -> None:
	"""Log a refused request, then raise PermissionError.

	Args:
		message: Translated text shown to the caller.
		action: Short name of what was attempted, e.g. "switch" or "manage_roles".
		target: The user the request was aimed at, if any.

	Raises:
		frappe.PermissionError: Always.
	"""
	frappe.logger("user_switcher").warning(
		"denied %s: session_user=%s real_user=%s target=%s ip=%s",
		action,
		frappe.session.user,
		_real_user(),
		target,
		getattr(frappe.local, "request_ip", None),
	)
	frappe.throw(message, frappe.PermissionError)


def end_orphaned_session() -> None:
	"""`before_request` hook: end an impersonated session once its real user may no longer switch.

	Without this, disabling the System Manager, removing their role or turning the switcher off
	would leave the impersonated session running as the target user until it expires.

	Raises:
		frappe.SessionExpired: The session was ended; the browser goes back to the login page.
	"""
	impersonator = (getattr(frappe.session, "data", None) or {}).get("impersonated_by")
	if not impersonator or _can_switch(impersonator):
		return
	frappe.logger("user_switcher").warning(
		"ended orphaned session: session_user=%s impersonated_by=%s", frappe.session.user, impersonator
	)
	delete_session(frappe.session.sid, reason="User Switcher: the real user may no longer switch")
	# The error handler rolls the request back, which would undo the delete
	frappe.db.commit()
	raise frappe.SessionExpired


@frappe.whitelist()
def get_context(
	txt: str | None = None, user_type: str | None = None, limit: int = 30, cached: list | str | None = None
):
	"""Return switcher state and a filtered user list.

	Args:
		txt: Optional text matched against user id and full name.
		user_type: Optional "System User" or "Website User" filter.
		limit: Max users returned (capped at 100); 0 returns only the `allowed` flag.
		cached: Optional user ids the browser has pinned or remembered; those that were deleted
			or disabled come back in `stale` so the UI can forget them.

	Returns:
		`{"allowed": False}` for unauthorised users (never throws), else the switcher state.
	"""
	real_user = _real_user()
	if not _can_switch(real_user):
		return {"allowed": False}

	limit = max(0, min(int(limit), 100))
	if not limit:
		return {"allowed": True}

	users = _find_users(real_user, txt, user_type, limit)

	return {
		"allowed": True,
		"real_user": _user_info(real_user),
		"current_user": _user_info(frappe.session.user),
		"is_switched": real_user != frappe.session.user,
		"users": users,
		"stale": _stale_users(cached),
	}


def _stale_users(cached: list | str | None) -> list[str]:
	names = frappe.parse_json(cached) if isinstance(cached, str) else (cached or [])
	names = [n for n in names if isinstance(n, str)][:200]
	if not names:
		return []
	alive = set(frappe.get_all("User", filters={"name": ["in", names], "enabled": 1}, pluck="name", ignore_permissions=True))
	return [n for n in names if n not in alive]


def _find_users(real_user: str, txt: str | None, user_type: str | None, limit: int) -> list[dict]:
	filters = {"enabled": 1, "name": ["not in", ["Guest", frappe.session.user]]}
	filters["name"][1].extend(_blocked_targets(real_user))

	if user_type in ("System User", "Website User"):
		filters["user_type"] = user_type

	or_filters = None
	if txt:
		like = f"%{_escape_like(txt)}%"
		or_filters = {"name": ["like", like], "full_name": ["like", like]}

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


def log_switch(real_user: str, target_user: str) -> None:
	"""Record a completed switch in a read-only User Switch Log.

	Args:
		real_user: The user who actually logged in.
		target_user: The user the session now belongs to.
	"""
	doc = frappe.get_doc(
		{
			"doctype": "User Switch Log",
			"real_user": real_user,
			"target_user": target_user,
			"action": "Switch" if target_user != real_user else "Switch Back",
			"ip_address": frappe.local.request_ip,
		}
	)
	doc.flags.from_switcher = True
	# ? SWITCHER IS ALREADY GATED BY _can_switch; THE TARGET USER MAY HAVE NO PERMISSION ON THIS DOCTYPE
	doc.insert(ignore_permissions=True)


@frappe.whitelist(methods=["POST"])
def switch_to_user(target_user: str):
	"""Start a new session as `target_user` and log it.

	Args:
		target_user: Id of an enabled User to switch into.

	Returns:
		`{"current_user": target_user}`.

	Raises:
		frappe.PermissionError: Caller may not switch, or the target is blocked (see `_blocked_targets`).
		frappe.ValidationError: Target is Guest, missing or disabled.
	"""
	real_user = _real_user()
	if not _can_switch(real_user):
		_deny(_("Not permitted to switch users"), "switch", target_user)

	if target_user == "Guest" or not frappe.db.get_value("User", target_user, "enabled"):
		frappe.throw(_("Cannot switch to this user"))

	if target_user != real_user and target_user in _blocked_targets(real_user):
		_deny(_("You are not permitted to switch into this user"), "switch", target_user)

	if target_user == frappe.session.user:
		return {"current_user": target_user}

	# ? LOG FIRST SO A FAILED AUDIT WRITE BLOCKS THE SWITCH INSTEAD OF LEAVING IT UNRECORDED
	log_switch(real_user, target_user)

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

	return {"current_user": target_user}


@frappe.whitelist(methods=["POST"])
def switch_back():
	"""Return to the user who originally logged in."""
	return switch_to_user(_real_user())


@frappe.whitelist()
def get_assignable_roles():
	"""Roles offered when creating a test user. `desk_access` decides System vs Website user."""
	if not _can_switch():
		_deny(_("Not permitted"), "list_roles")
	return frappe.get_all(
		"Role",
		filters={"disabled": 0, "name": ["not in", AUTOMATIC_ROLES]},
		fields=["name", "desk_access"],
		order_by="name asc",
		ignore_permissions=True,
	)


@frappe.whitelist(methods=["POST"])
def create_test_user(full_name: str, email: str, roles: list | str | None = None, switch: int = 1):
	"""Create an enabled test user with the given roles, optionally switching into it.

	Args:
		full_name: Display name; split on the first space into first/last name.
		email: Unique email, used as the User id.
		roles: List (or JSON string) of role names; automatic and disabled roles are dropped.
		switch: Truthy to switch into the new user right after creation.

	Returns:
		Dict with the new user's `name`, `full_name`, `user_type` and `roles`.

	Raises:
		frappe.PermissionError: Caller may not switch users.
		frappe.DuplicateEntryError: A user with this email already exists.
	"""
	real_user = _real_user()
	if not _can_switch(real_user):
		_deny(_("Not permitted to create test users"), "create_test_user", email)

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
	# ? WHILE SWITCHED, THE INSERT OWNER IS THE IMPERSONATED USER; _blocked_targets NEEDS THE REAL ONE
	frappe.db.set_value("User", user.name, "owner", real_user, update_modified=False)

	if int(switch):
		switch_to_user(user.name)

	return {"name": user.name, "full_name": user.full_name, "user_type": user.user_type, "roles": sorted(valid_roles)}


def _check_role_target(user: str) -> str:
	"""Raise unless the caller may edit `user`'s roles; returns the real (logged-in) user."""
	real_user = _real_user()
	if not _can_switch(real_user):
		_deny(_("Not permitted to manage roles"), "manage_roles", user)
	if user in ("Administrator", "Guest") or not frappe.db.exists("User", user):
		frappe.throw(_("Cannot manage roles of this user"))
	if user not in (real_user, frappe.session.user) and user in _blocked_targets(real_user):
		_deny(_("You are not permitted to manage roles of this user"), "manage_roles", user)
	return real_user


@frappe.whitelist()
def get_user_roles(user: str) -> list[str]:
	"""Roles currently assigned to `user`, minus the automatic ones."""
	_check_role_target(user)
	return frappe.get_all(
		"Has Role",
		filters={"parenttype": "User", "parent": user, "role": ["not in", AUTOMATIC_ROLES]},
		pluck="role",
		order_by="role asc",
		ignore_permissions=True,
	)


@frappe.whitelist(methods=["POST"])
def set_user_roles(user: str, roles: list | str | None = None):
	"""Make `user`'s assignable roles exactly `roles`; roles outside that set are left alone.

	Args:
		user: Id of the User to change (the signed-in user, or any user the caller may switch into).
		roles: List (or JSON string) of role names that user should end up with.

	Returns:
		Dict with the user's `name`, `user_type` and final `roles`.

	Raises:
		frappe.PermissionError: Caller may not switch users, or the target is blocked.
		frappe.ValidationError: Target is Administrator/Guest/missing, or the caller would drop their own System Manager.
	"""
	real_user = _check_role_target(user)

	roles = frappe.parse_json(roles) if isinstance(roles, str) else (roles or [])
	assignable = set(frappe.get_all("Role", filters={"disabled": 0}, pluck="name")) - set(AUTOMATIC_ROLES)
	wanted = set(roles) & assignable

	doc = frappe.get_doc("User", user)
	current = {d.role for d in doc.roles} & assignable
	if user == real_user and "System Manager" in current - wanted:
		frappe.throw(_("You cannot remove System Manager from your own account here"))

	doc.append_roles(*sorted(wanted - current))
	doc.set("roles", [d for d in doc.roles if d.role not in current - wanted])
	# ? THE SWITCHER IS ALREADY GATED BY _can_switch; WHILE SWITCHED THE SESSION USER MAY NOT BE ABLE TO WRITE USERS
	doc.flags.ignore_permissions = True
	doc.save()

	return {"name": doc.name, "user_type": doc.user_type, "roles": sorted(wanted)}
