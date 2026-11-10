from django.contrib import admin

from spaces.models import Item, Space


def purge_files(modeladmin, request, queryset):
    """Takes the stored file off the disk. This cannot be undone."""
    for item in queryset.exclude(file=""):
        item.file.delete(save=False)
        item.size = 0
        item.sha256 = ""
        item.file = None
        item.save(update_fields=["file", "size", "sha256"])

purge_files.short_description = "Delete the stored files of these items"


class SpaceAdmin(admin.ModelAdmin):
    list_display = ("name", "creator", "created_at")
    raw_id_fields = ("creator", "contention")
    exclude = ("token", "hook_key", "anarlog_secret")


class ItemAdmin(admin.ModelAdmin):
    list_display = ("title", "space", "kind", "size", "author_name",
                    "created_at", "removed_at")
    list_filter = ("kind", "source")
    raw_id_fields = ("space", "session", "author")
    actions = [purge_files]


admin.site.register(Space, SpaceAdmin)
admin.site.register(Item, ItemAdmin)
