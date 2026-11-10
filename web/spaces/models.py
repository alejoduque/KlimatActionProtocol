# -*- coding: utf-8 -*-
import base64
import json
import os
import uuid

from django.conf import settings
from django.core.urlresolvers import reverse
from django.db import models
from django.db.models import Sum
from django.utils.encoding import python_2_unicode_compatible
from django.utils.timezone import now
from django.utils.translation import ugettext_lazy as _

from markdown2 import markdown

from premises.models import Contention
from spaces.filetypes import INLINE_TYPES

MAX_NAME_LENGTH = 30

FILE, SCREENSHOT, PDF, URL, TEXT, SUMMARY = (
    "file", "screenshot", "pdf", "url", "text", "summary")
ITEM_KINDS = (
    (FILE, _("file")),
    (SCREENSHOT, _("screenshot")),
    (PDF, _("pdf")),
    (URL, _("link")),
    (TEXT, _("text")),
    (SUMMARY, _("meeting summary")),
)
FILE_KINDS = (FILE, SCREENSHOT, PDF)
TEXT_KINDS = (TEXT, SUMMARY)

SOURCE_UPLOAD, SOURCE_CHAT, SOURCE_ANARLOG = "upload", "chat", "anarlog"
ITEM_SOURCES = (
    (SOURCE_UPLOAD, _("library")),
    (SOURCE_CHAT, _("chat")),
    (SOURCE_ANARLOG, _("anarlog")),
)


def new_token():
    """128 random bits, the only key to a space."""
    return base64.urlsafe_b64encode(os.urandom(16)).rstrip("=")


def stored_file_path(item, filename):
    # never the name that came with the file
    return "spaces/%d/%s" % (item.space_id, uuid.uuid4().hex)


def render_markdown(text):
    return markdown(text or u"", safe_mode="escape")


def name_of(user, fallback=u""):
    if user is None:
        return fallback
    return user.first_name or u"guest-%s" % user.username[:4]


@python_2_unicode_compatible
class Space(models.Model):
    token = models.CharField(max_length=32, unique=True, default=new_token)
    name = models.CharField(_("name"), max_length=120)
    creator = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True,
                                on_delete=models.SET_NULL,
                                related_name="created_spaces")
    contention = models.ForeignKey(Contention, null=True, blank=True,
                                   on_delete=models.SET_NULL,
                                   related_name="spaces")
    created_at = models.DateTimeField(default=now)
    # where anarlog delivers its events, apart from the link of the space
    hook_key = models.CharField(max_length=32, unique=True, default=new_token)
    anarlog_secret = models.CharField(max_length=255, blank=True)
    anarlog_transcripts = models.BooleanField(default=False)

    def __str__(self):
        return self.name

    def get_absolute_url(self):
        return reverse("space_detail", args=[self.token])

    @property
    def room(self):
        return "space:%s" % self.token

    def rotate_token(self):
        self.token = new_token()
        self.save(update_fields=["token"])

    def can_manage(self, user):
        return user.is_staff or user.pk == self.creator_id

    def used_bytes(self):
        # removed files stay on the disk until staff purge them
        return self.items.aggregate(total=Sum("size"))["total"] or 0

    def open_session(self):
        return self.sessions.filter(ended_at__isnull=True).first()


@python_2_unicode_compatible
class Session(models.Model):
    space = models.ForeignKey(Space, related_name="sessions")
    title = models.CharField(_("title"), max_length=200)
    started_at = models.DateTimeField(default=now)
    ended_at = models.DateTimeField(null=True, blank=True)
    started_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True,
                                   blank=True, on_delete=models.SET_NULL,
                                   related_name="started_sessions")

    class Meta:
        ordering = ["-started_at", "-id"]

    def __str__(self):
        return self.title

    def serialize(self):
        return {
            "id": self.pk,
            "title": self.title,
            "started_at": self.started_at.isoformat(),
            "ended_at": self.ended_at and self.ended_at.isoformat(),
        }


@python_2_unicode_compatible
class Category(models.Model):
    space = models.ForeignKey(Space, related_name="categories")
    name = models.CharField(_("name"), max_length=40)

    class Meta:
        ordering = ["name"]
        unique_together = (("space", "name"),)
        verbose_name_plural = "categories"

    def __str__(self):
        return self.name


@python_2_unicode_compatible
class Item(models.Model):
    space = models.ForeignKey(Space, related_name="items")
    session = models.ForeignKey(Session, null=True, blank=True,
                                on_delete=models.SET_NULL, related_name="items")
    author = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True,
                               on_delete=models.SET_NULL,
                               related_name="space_items")
    author_name = models.CharField(max_length=MAX_NAME_LENGTH, blank=True)
    kind = models.CharField(max_length=12, choices=ITEM_KINDS)
    source = models.CharField(max_length=8, choices=ITEM_SOURCES,
                              default=SOURCE_UPLOAD)
    title = models.CharField(_("title"), max_length=255)
    file = models.FileField(upload_to=stored_file_path, null=True, blank=True,
                            max_length=255)
    filename = models.CharField(max_length=255, blank=True)
    url = models.URLField(max_length=2000, blank=True)
    body = models.TextField(blank=True)
    size = models.BigIntegerField(default=0)
    sha256 = models.CharField(max_length=64, blank=True)
    mime = models.CharField(max_length=120, blank=True)
    categories = models.ManyToManyField(Category, blank=True,
                                        related_name="items")
    # JSON list; what categorize.suggest found when the item was added
    suggested = models.TextField(blank=True, default="[]")
    # the same meeting from anarlog updates its item and does not add another
    external_id = models.CharField(max_length=120, null=True, blank=True)
    created_at = models.DateTimeField(default=now)
    removed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        unique_together = (("space", "external_id"),)

    def __str__(self):
        return self.title

    def category_names(self):
        return [category.name for category in self.categories.all()]

    def is_inline(self):
        return self.mime in INLINE_TYPES

    def file_url(self):
        if not self.file:
            return None
        return reverse("space_file", args=[self.space.token, self.pk])

    def can_remove(self, user):
        return self.space.can_manage(user) or (
            self.author_id is not None and user.pk == self.author_id)

    def serialize(self, full=False):
        data = {
            "id": self.pk,
            "kind": self.kind,
            "source": self.source,
            "title": self.title,
            "url": self.url,
            "filename": self.filename,
            "size": self.size,
            "mime": self.mime,
            "inline": self.is_inline(),
            "file": self.file_url(),
            "author": self.author_name,
            "session": self.session_id,
            "categories": self.category_names(),
            "suggested": json.loads(self.suggested or "[]"),
            "excerpt": self.body[:200],
            "created_at": self.created_at.isoformat(),
        }
        if full:
            data["body"] = self.body
            data["html"] = render_markdown(self.body) if self.body else u""
            data["editable"] = self.kind in TEXT_KINDS
        return data

    def snapshot(self, user, name):
        return ItemRevision.objects.create(
            item=self, title=self.title, body=self.body,
            categories=json.dumps(sorted(self.category_names())),
            author=user, author_name=name)


@python_2_unicode_compatible
class ItemRevision(models.Model):
    """Each version of an item. Only added to, like the history of a wiki."""
    item = models.ForeignKey(Item, related_name="revisions")
    title = models.CharField(max_length=255)
    body = models.TextField(blank=True)
    categories = models.TextField(default="[]")  # JSON list
    author = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True,
                               on_delete=models.SET_NULL,
                               related_name="+")
    author_name = models.CharField(max_length=MAX_NAME_LENGTH, blank=True)
    created_at = models.DateTimeField(default=now)

    class Meta:
        ordering = ["-created_at", "-id"]

    def __str__(self):
        return self.title

    def serialize(self):
        return {
            "id": self.pk,
            "title": self.title,
            "body": self.body,
            "categories": json.loads(self.categories),
            "author": self.author_name,
            "created_at": self.created_at.isoformat(),
        }


@python_2_unicode_compatible
class ChatMessage(models.Model):
    space = models.ForeignKey(Space, related_name="messages")
    session = models.ForeignKey(Session, null=True, blank=True,
                                on_delete=models.SET_NULL,
                                related_name="messages")
    author = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True,
                               on_delete=models.SET_NULL,
                               related_name="space_messages")
    author_name = models.CharField(max_length=MAX_NAME_LENGTH, blank=True)
    text = models.TextField(blank=True)
    items = models.ManyToManyField(Item, blank=True, related_name="messages")
    created_at = models.DateTimeField(default=now)

    class Meta:
        ordering = ["id"]

    def __str__(self):
        return self.text[:40]

    def serialize(self):
        return {
            "id": self.pk,
            "author": self.author_name,
            "text": self.text,
            "session": self.session_id,
            "created_at": self.created_at.isoformat(),
            "items": [item.serialize() for item in self.items.all()
                      if item.removed_at is None],
        }


@python_2_unicode_compatible
class PadRevision(models.Model):
    """Saved states of the notes of a session; only added to."""
    session = models.ForeignKey(Session, related_name="pad_revisions")
    text = models.TextField(blank=True)
    state = models.BinaryField()  # Y.encodeStateAsUpdate
    created_at = models.DateTimeField(default=now)

    class Meta:
        ordering = ["-id"]

    def __str__(self):
        return u"%s (%s)" % (self.session, self.created_at)


@python_2_unicode_compatible
class LogEntry(models.Model):
    """The history of a space: what happened, in order."""
    space = models.ForeignKey(Space, related_name="log")
    session = models.ForeignKey(Session, null=True, blank=True,
                                on_delete=models.SET_NULL, related_name="log")
    item = models.ForeignKey(Item, null=True, blank=True,
                             on_delete=models.SET_NULL, related_name="log")
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True,
                              on_delete=models.SET_NULL, related_name="+")
    actor_name = models.CharField(max_length=MAX_NAME_LENGTH, blank=True)
    action = models.CharField(max_length=24)
    detail = models.CharField(max_length=500, blank=True)
    created_at = models.DateTimeField(default=now)

    class Meta:
        ordering = ["-id"]

    def __str__(self):
        return u"%s %s" % (self.action, self.detail)
