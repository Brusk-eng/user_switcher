# * user_switcher/user_switcher/doctype/user_switch_log/user_switch_log.py
import frappe
from frappe import _
from frappe.model.document import Document


class UserSwitchLog(Document):
	"""Read-only audit record, created only by `user_switcher.api.log_switch`."""

	def before_insert(self):
		# ? ONLY THE SWITCHER MAY WRITE LOGS, EVEN FOR ADMINISTRATOR WHO BYPASSES PERMISSIONS
		if not self.flags.from_switcher:
			frappe.throw(_("User Switch Logs are created automatically"), frappe.PermissionError)

	def validate(self):
		if not self.is_new():
			frappe.throw(_("User Switch Logs cannot be edited"), frappe.PermissionError)

	def on_trash(self):
		frappe.throw(_("User Switch Logs cannot be deleted"), frappe.PermissionError)
