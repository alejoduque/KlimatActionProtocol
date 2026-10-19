# -*- coding: utf-8 -*-
from __future__ import unicode_literals

from django.db import models, migrations


class Migration(migrations.Migration):

    dependencies = [
        ('premises', '0037_missing_migrations'),
    ]

    operations = [
        migrations.AddField(
            model_name='premise',
            name='anchor_start',
            field=models.PositiveIntegerField(null=True, blank=True),
            preserve_default=True,
        ),
        migrations.AddField(
            model_name='premise',
            name='anchor_end',
            field=models.PositiveIntegerField(null=True, blank=True),
            preserve_default=True,
        ),
        migrations.AddField(
            model_name='premise',
            name='anchor_text',
            field=models.CharField(max_length=255, null=True, blank=True),
            preserve_default=True,
        ),
        migrations.AddField(
            model_name='premise',
            name='tbt',
            field=models.TextField(null=True, blank=True),
            preserve_default=True,
        ),
        migrations.AlterField(
            model_name='premise',
            name='premise_type',
            field=models.IntegerField(default=1, verbose_name='Premise Type', choices=[(0, 'but'), (1, 'because'), (2, 'however'), (3, 'and so'), (4, 'on the contrary'), (5, 'in other words'), (6, 'what do we mean by'), (7, 'what if')]),
        ),
    ]
