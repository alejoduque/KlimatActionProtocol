# -*- coding: utf-8 -*-
from __future__ import unicode_literals

from django.db import models, migrations


class Migration(migrations.Migration):
    """Claims can be in Italian and in German too (AVAILABLE_LANGUAGES)."""

    dependencies = [
        ('premises', '0039_spanish'),
    ]

    operations = [
        migrations.AlterField(
            model_name='contention',
            name='language',
            field=models.CharField(max_length=5, null=True, choices=[(b'en', b'en'), (b'es', b'es'), (b'it', b'it'), (b'de', b'de')]),
        ),
    ]
