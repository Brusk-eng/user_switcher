frappe.query_reports["User Switch Log Report"] = {
	filters: [
		{ fieldname: "from_date", label: __("From Date"), fieldtype: "Date", default: frappe.datetime.add_days(frappe.datetime.get_today(), -30) },
		{ fieldname: "to_date", label: __("To Date"), fieldtype: "Date", default: frappe.datetime.get_today() },
		{ fieldname: "real_user", label: __("Real User"), fieldtype: "Link", options: "User" },
		{ fieldname: "target_user", label: __("Target User"), fieldtype: "Link", options: "User" },
		{ fieldname: "ip_address", label: __("IP Address"), fieldtype: "Data" },
		{ fieldname: "action", label: __("Action"), fieldtype: "Select", options: "\nSwitch\nSwitch Back" },
	],
};
