# * user_switcher/boot.py
from user_switcher.api import _can_switch


def extend_bootinfo(bootinfo):
	bootinfo.user_switcher_allowed = _can_switch()
