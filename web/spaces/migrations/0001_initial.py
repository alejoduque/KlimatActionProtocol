# -*- coding: utf-8 -*-
from __future__ import unicode_literals

from django.db import models, migrations
import spaces.models
import django.db.models.deletion
import django.utils.timezone
from django.conf import settings


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ('premises', '0039_spanish'),
    ]

    operations = [
        migrations.CreateModel(
            name='Category',
            fields=[
                ('id', models.AutoField(verbose_name='ID', serialize=False, auto_created=True, primary_key=True)),
                ('name', models.CharField(max_length=40, verbose_name='name')),
            ],
            options={
                'ordering': ['name'],
                'verbose_name_plural': 'categories',
            },
            bases=(models.Model,),
        ),
        migrations.CreateModel(
            name='ChatMessage',
            fields=[
                ('id', models.AutoField(verbose_name='ID', serialize=False, auto_created=True, primary_key=True)),
                ('author_name', models.CharField(max_length=30, blank=True)),
                ('text', models.TextField(blank=True)),
                ('created_at', models.DateTimeField(default=django.utils.timezone.now)),
                ('author', models.ForeignKey(related_name=b'space_messages', on_delete=django.db.models.deletion.SET_NULL, blank=True, to=settings.AUTH_USER_MODEL, null=True)),
            ],
            options={
                'ordering': ['id'],
            },
            bases=(models.Model,),
        ),
        migrations.CreateModel(
            name='Item',
            fields=[
                ('id', models.AutoField(verbose_name='ID', serialize=False, auto_created=True, primary_key=True)),
                ('author_name', models.CharField(max_length=30, blank=True)),
                ('kind', models.CharField(max_length=12, choices=[(b'file', 'file'), (b'screenshot', 'screenshot'), (b'pdf', 'pdf'), (b'url', 'link'), (b'text', 'text'), (b'summary', 'meeting summary')])),
                ('source', models.CharField(default=b'upload', max_length=8, choices=[(b'upload', 'library'), (b'chat', 'chat'), (b'anarlog', 'anarlog')])),
                ('title', models.CharField(max_length=255, verbose_name='title')),
                ('file', models.FileField(max_length=255, null=True, upload_to=spaces.models.stored_file_path, blank=True)),
                ('filename', models.CharField(max_length=255, blank=True)),
                ('url', models.URLField(max_length=2000, blank=True)),
                ('body', models.TextField(blank=True)),
                ('size', models.BigIntegerField(default=0)),
                ('sha256', models.CharField(max_length=64, blank=True)),
                ('mime', models.CharField(max_length=120, blank=True)),
                ('suggested', models.TextField(default=b'[]', blank=True)),
                ('external_id', models.CharField(max_length=120, null=True, blank=True)),
                ('created_at', models.DateTimeField(default=django.utils.timezone.now)),
                ('removed_at', models.DateTimeField(null=True, blank=True)),
                ('author', models.ForeignKey(related_name=b'space_items', on_delete=django.db.models.deletion.SET_NULL, blank=True, to=settings.AUTH_USER_MODEL, null=True)),
                ('categories', models.ManyToManyField(related_name=b'items', to='spaces.Category', blank=True)),
            ],
            options={
                'ordering': ['-created_at', '-id'],
            },
            bases=(models.Model,),
        ),
        migrations.CreateModel(
            name='ItemRevision',
            fields=[
                ('id', models.AutoField(verbose_name='ID', serialize=False, auto_created=True, primary_key=True)),
                ('title', models.CharField(max_length=255)),
                ('body', models.TextField(blank=True)),
                ('categories', models.TextField(default=b'[]')),
                ('author_name', models.CharField(max_length=30, blank=True)),
                ('created_at', models.DateTimeField(default=django.utils.timezone.now)),
                ('author', models.ForeignKey(related_name=b'+', on_delete=django.db.models.deletion.SET_NULL, blank=True, to=settings.AUTH_USER_MODEL, null=True)),
                ('item', models.ForeignKey(related_name=b'revisions', to='spaces.Item')),
            ],
            options={
                'ordering': ['-created_at', '-id'],
            },
            bases=(models.Model,),
        ),
        migrations.CreateModel(
            name='LogEntry',
            fields=[
                ('id', models.AutoField(verbose_name='ID', serialize=False, auto_created=True, primary_key=True)),
                ('actor_name', models.CharField(max_length=30, blank=True)),
                ('action', models.CharField(max_length=24)),
                ('detail', models.CharField(max_length=500, blank=True)),
                ('created_at', models.DateTimeField(default=django.utils.timezone.now)),
                ('actor', models.ForeignKey(related_name=b'+', on_delete=django.db.models.deletion.SET_NULL, blank=True, to=settings.AUTH_USER_MODEL, null=True)),
                ('item', models.ForeignKey(related_name=b'log', on_delete=django.db.models.deletion.SET_NULL, blank=True, to='spaces.Item', null=True)),
            ],
            options={
                'ordering': ['-id'],
            },
            bases=(models.Model,),
        ),
        migrations.CreateModel(
            name='PadRevision',
            fields=[
                ('id', models.AutoField(verbose_name='ID', serialize=False, auto_created=True, primary_key=True)),
                ('text', models.TextField(blank=True)),
                ('state', models.BinaryField()),
                ('created_at', models.DateTimeField(default=django.utils.timezone.now)),
            ],
            options={
                'ordering': ['-id'],
            },
            bases=(models.Model,),
        ),
        migrations.CreateModel(
            name='Session',
            fields=[
                ('id', models.AutoField(verbose_name='ID', serialize=False, auto_created=True, primary_key=True)),
                ('title', models.CharField(max_length=200, verbose_name='title')),
                ('started_at', models.DateTimeField(default=django.utils.timezone.now)),
                ('ended_at', models.DateTimeField(null=True, blank=True)),
            ],
            options={
                'ordering': ['-started_at', '-id'],
            },
            bases=(models.Model,),
        ),
        migrations.CreateModel(
            name='Space',
            fields=[
                ('id', models.AutoField(verbose_name='ID', serialize=False, auto_created=True, primary_key=True)),
                ('token', models.CharField(default=spaces.models.new_token, unique=True, max_length=32)),
                ('name', models.CharField(max_length=120, verbose_name='name')),
                ('created_at', models.DateTimeField(default=django.utils.timezone.now)),
                ('hook_key', models.CharField(default=spaces.models.new_token, unique=True, max_length=32)),
                ('anarlog_secret', models.CharField(max_length=255, blank=True)),
                ('anarlog_transcripts', models.BooleanField(default=False)),
                ('contention', models.ForeignKey(related_name=b'spaces', on_delete=django.db.models.deletion.SET_NULL, blank=True, to='premises.Contention', null=True)),
                ('creator', models.ForeignKey(related_name=b'created_spaces', on_delete=django.db.models.deletion.SET_NULL, blank=True, to=settings.AUTH_USER_MODEL, null=True)),
            ],
            options={
            },
            bases=(models.Model,),
        ),
        migrations.AddField(
            model_name='session',
            name='space',
            field=models.ForeignKey(related_name=b'sessions', to='spaces.Space'),
            preserve_default=True,
        ),
        migrations.AddField(
            model_name='session',
            name='started_by',
            field=models.ForeignKey(related_name=b'started_sessions', on_delete=django.db.models.deletion.SET_NULL, blank=True, to=settings.AUTH_USER_MODEL, null=True),
            preserve_default=True,
        ),
        migrations.AddField(
            model_name='padrevision',
            name='session',
            field=models.ForeignKey(related_name=b'pad_revisions', to='spaces.Session'),
            preserve_default=True,
        ),
        migrations.AddField(
            model_name='logentry',
            name='session',
            field=models.ForeignKey(related_name=b'log', on_delete=django.db.models.deletion.SET_NULL, blank=True, to='spaces.Session', null=True),
            preserve_default=True,
        ),
        migrations.AddField(
            model_name='logentry',
            name='space',
            field=models.ForeignKey(related_name=b'log', to='spaces.Space'),
            preserve_default=True,
        ),
        migrations.AddField(
            model_name='item',
            name='session',
            field=models.ForeignKey(related_name=b'items', on_delete=django.db.models.deletion.SET_NULL, blank=True, to='spaces.Session', null=True),
            preserve_default=True,
        ),
        migrations.AddField(
            model_name='item',
            name='space',
            field=models.ForeignKey(related_name=b'items', to='spaces.Space'),
            preserve_default=True,
        ),
        migrations.AlterUniqueTogether(
            name='item',
            unique_together=set([('space', 'external_id')]),
        ),
        migrations.AddField(
            model_name='chatmessage',
            name='items',
            field=models.ManyToManyField(related_name=b'messages', to='spaces.Item', blank=True),
            preserve_default=True,
        ),
        migrations.AddField(
            model_name='chatmessage',
            name='session',
            field=models.ForeignKey(related_name=b'messages', on_delete=django.db.models.deletion.SET_NULL, blank=True, to='spaces.Session', null=True),
            preserve_default=True,
        ),
        migrations.AddField(
            model_name='chatmessage',
            name='space',
            field=models.ForeignKey(related_name=b'messages', to='spaces.Space'),
            preserve_default=True,
        ),
        migrations.AddField(
            model_name='category',
            name='space',
            field=models.ForeignKey(related_name=b'categories', to='spaces.Space'),
            preserve_default=True,
        ),
        migrations.AlterUniqueTogether(
            name='category',
            unique_together=set([('space', 'name')]),
        ),
    ]
