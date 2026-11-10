from django.conf.urls import patterns, url

from spaces import views

TOKEN = r"(?P<token>[\w-]{22})"

urlpatterns = patterns('',
    url(r'^$', views.SpaceCreateView.as_view(), name='space_create'),
    url(r'^hook/(?P<hook_key>[\w-]{22})$', views.AnarlogHookView.as_view(),
        name='space_anarlog_hook'),
    url(r'^%s$' % TOKEN, views.SpaceDetailView.as_view(), name='space_detail'),
    url(r'^%s/rotate$' % TOKEN, views.SpaceRotateView.as_view(),
        name='space_rotate'),
    url(r'^%s/state\.json$' % TOKEN, views.SpaceStateView.as_view(),
        name='space_state'),
    url(r'^%s/log$' % TOKEN, views.SpaceLogView.as_view(), name='space_log'),

    url(r'^%s/sessions/new$' % TOKEN, views.SessionCreateView.as_view(),
        name='space_session_new'),
    url(r'^%s/sessions/(?P<pk>\d+)/end$' % TOKEN,
        views.SessionEndView.as_view(), name='space_session_end'),
    url(r'^%s/sessions/(?P<pk>\d+)\.md$' % TOKEN,
        views.SessionExportView.as_view(), name='space_session_export'),
    url(r'^%s/sessions/(?P<pk>\d+)/notes-declared$' % TOKEN,
        views.TakingNotesView.as_view(), name='space_taking_notes'),
    url(r'^%s/sessions/(?P<pk>\d+)/anarlog$' % TOKEN,
        views.AnarlogImportView.as_view(), name='space_anarlog_import'),
    url(r'^%s/anarlog-hook$' % TOKEN, views.AnarlogHookSettingsView.as_view(),
        name='space_anarlog_settings'),

    url(r'^%s/sessions/(?P<pk>\d+)/pad$' % TOKEN, views.PadView.as_view(),
        name='space_pad'),
    url(r'^%s/sessions/(?P<pk>\d+)/pad/revisions$' % TOKEN,
        views.PadRevisionsView.as_view(), name='space_pad_revisions'),
    url(r'^%s/sessions/(?P<pk>\d+)/pad/revisions/(?P<revision>\d+)$' % TOKEN,
        views.PadRevisionView.as_view(), name='space_pad_revision'),

    url(r'^%s/items\.json$' % TOKEN, views.ItemListView.as_view(),
        name='space_items'),
    url(r'^%s/items/upload$' % TOKEN, views.ItemUploadView.as_view(),
        name='space_item_upload'),
    url(r'^%s/items/new$' % TOKEN, views.ItemCreateView.as_view(),
        name='space_item_new'),
    url(r'^%s/items/(?P<pk>\d+)$' % TOKEN, views.ItemDetailView.as_view(),
        name='space_item'),
    url(r'^%s/items/(?P<pk>\d+)/remove$' % TOKEN,
        views.ItemRemoveView.as_view(), name='space_item_remove'),
    url(r'^%s/items/(?P<pk>\d+)/session$' % TOKEN,
        views.ItemSessionView.as_view(), name='space_item_session'),
    url(r'^%s/files/(?P<pk>\d+)$' % TOKEN, views.ItemFileView.as_view(),
        name='space_file'),

    url(r'^%s/chat\.json$' % TOKEN, views.ChatListView.as_view(),
        name='space_chat'),
    url(r'^%s/chat$' % TOKEN, views.ChatPostView.as_view(),
        name='space_chat_post'),
)
