# * user_switcher/patches/delete_user_switch_page.py
import frappe


def execute():
	"""Delete the Page record of the removed Ctrl+K fallback page; safe to run again."""
	frappe.delete_doc("Page", "user-switch", force=True, ignore_missing=True, ignore_permissions=True)
