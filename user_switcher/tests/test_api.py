# * user_switcher/tests/test_api.py
from unittest.mock import MagicMock, patch

import frappe
from frappe.tests import IntegrationTestCase

from user_switcher import api


class TestUserSwitcherAccess(IntegrationTestCase):
	def test_escape_like(self):
		self.assertEqual(api._escape_like("a%b_c"), "a\\%b\\_c")

	def test_disabled_without_developer_mode(self):
		with patch.object(frappe.local, "conf", frappe._dict(developer_mode=0)):
			self.assertFalse(api._can_switch("Administrator"))

	def test_guest_never_allowed(self):
		with patch.object(frappe.local, "conf", frappe._dict(developer_mode=1)):
			self.assertFalse(api._can_switch("Guest"))
			self.assertTrue(api._can_switch("Administrator"))

	def test_system_manager_cannot_list_administrator(self):
		with patch.object(frappe.local, "conf", frappe._dict(developer_mode=1)):
			names = [u.name for u in api._find_users("test@example.com", None, None, 100)]
		self.assertNotIn("Administrator", names)


class TestUserSwitchLog(IntegrationTestCase):
	def test_manual_create_blocked(self):
		doc = frappe.get_doc({"doctype": "User Switch Log", "real_user": "Administrator", "target_user": "Guest"})
		self.assertRaises(frappe.PermissionError, doc.insert)

	def test_log_switch_creates_readonly_record(self):
		api.log_switch("Administrator", "Guest")
		name = frappe.db.get_value("User Switch Log", {"target_user": "Guest"}, "name")
		doc = frappe.get_doc("User Switch Log", name)
		doc.action = "Switch Back"
		self.assertRaises(frappe.PermissionError, doc.save)

	def test_delete_blocked(self):
		api.log_switch("Administrator", "Guest")
		name = frappe.db.get_value("User Switch Log", {"target_user": "Guest"}, "name")
		self.assertRaises(frappe.PermissionError, frappe.delete_doc, "User Switch Log", name)


class TestBlockedTargets(IntegrationTestCase):
	def test_administrator_has_no_blocked_targets(self):
		self.assertEqual(api._blocked_targets("Administrator"), [])

	def test_system_manager_blocked_from_administrator_and_other_managers(self):
		frappe.set_user("Administrator")
		frappe.get_doc(
			{"doctype": "User", "email": "us_sm_a@example.com", "first_name": "A", "send_welcome_email": 0,
			 "roles": [{"role": "System Manager"}]}
		).insert()
		frappe.get_doc(
			{"doctype": "User", "email": "us_sm_b@example.com", "first_name": "B", "send_welcome_email": 0,
			 "roles": [{"role": "System Manager"}]}
		).insert()
		blocked = api._blocked_targets("us_sm_a@example.com")
		self.assertIn("Administrator", blocked)
		self.assertIn("us_sm_b@example.com", blocked)

		frappe.db.set_value("User", "us_sm_b@example.com", "owner", "us_sm_a@example.com")
		self.assertNotIn("us_sm_b@example.com", api._blocked_targets("us_sm_a@example.com"))

		frappe.utils.password.update_password("us_sm_b@example.com", "Str0ng!Pass#2026")
		self.assertIn("us_sm_b@example.com", api._blocked_targets("us_sm_a@example.com"))


class TestManageRoles(IntegrationTestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		self.conf = patch.object(frappe.local, "conf", frappe._dict(developer_mode=1))
		self.conf.start()
		self.addCleanup(self.conf.stop)

	def _user(self, email, roles=()):
		return frappe.get_doc(
			{"doctype": "User", "email": email, "first_name": "R", "send_welcome_email": 0,
			 "roles": [{"role": r} for r in roles]}
		).insert().name

	def test_add_and_remove_roles(self):
		user = self._user("us_roles_t@example.com", ["Website Manager"])
		self.assertEqual(api.get_user_roles(user), ["Website Manager"])

		api.set_user_roles(user, ["Newsletter Manager"])
		self.assertEqual(api.get_user_roles(user), ["Newsletter Manager"])

		api.set_user_roles(user, '["Website Manager", "Newsletter Manager", "All"]')
		self.assertEqual(api.get_user_roles(user), ["Newsletter Manager", "Website Manager"])

	def test_administrator_and_guest_not_editable(self):
		for user in ("Administrator", "Guest"):
			self.assertRaises(frappe.ValidationError, api.set_user_roles, user, ["Website Manager"])

	def test_cannot_drop_own_system_manager(self):
		user = self._user("us_roles_sm@example.com", ["System Manager", "Website Manager"])
		with patch.object(api, "_real_user", return_value=user):
			self.assertRaises(frappe.ValidationError, api.set_user_roles, user, ["Website Manager"])
			api.set_user_roles(user, ["System Manager"])
		self.assertEqual(api.get_user_roles(user), ["System Manager"])


class TestSwitchHardening(IntegrationTestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		self.conf = patch.object(frappe.local, "conf", frappe._dict(developer_mode=1))
		self.conf.start()
		self.addCleanup(self.conf.stop)

	def test_negative_limit_is_clamped(self):
		self.assertEqual(api.get_context(limit=-5), {"allowed": True})

	def test_failed_audit_write_blocks_the_switch(self):
		target = frappe.get_doc(
			{"doctype": "User", "email": "us_audit_t@example.com", "first_name": "T", "send_welcome_email": 0}
		).insert().name
		login_manager = MagicMock()
		with (
			patch.object(frappe.local, "login_manager", login_manager, create=True),
			patch.object(frappe.local, "session_obj", MagicMock(), create=True),
			patch.object(api, "log_switch", side_effect=frappe.ValidationError("audit down")),
		):
			self.assertRaises(frappe.ValidationError, api.switch_to_user, target)
		login_manager.login_as.assert_not_called()

	def test_awesomebar_results_carry_no_trusted_flag(self):
		with patch.object(api, "_find_users", return_value=[frappe._dict(name="a@b.co", full_name="A", roles=[])]):
			results = api.awesomebar_search("su a")
		self.assertTrue(results)
		self.assertTrue(all("route_options" not in r for r in results))
