"""
Texts of django.contrib.humanize that KLAP translates again: Django 1.7
says "hacen 7 segundos" in Spanish, where it must say "hace 7 segundos".
KLAP's catalog (LOCALE_PATHS) goes before Django's; this file only lets
makemessages find the texts.
"""
from django.utils.translation import ungettext_lazy

NATURALTIME = (
    ungettext_lazy("a second ago", "%(count)s seconds ago", 0),
    ungettext_lazy("a minute ago", "%(count)s minutes ago", 0),
    ungettext_lazy("an hour ago", "%(count)s hours ago", 0),
)
