#!/usr/bin/env python3
# Adds "location /_space_files/" (the files of the spaces) to the nginx vhost
# of KLAP, before each "location / {" of a server block that proxies to
# gunicorn. Only Django can send people there (internal). Checks the result
# with nginx -t and reloads nginx; restores the backup when anything fails.
# Run as root:
#   python3 nginx_files.py <directory of the files> [vhost]
# web/spaces/install.sh runs it.
import re
import shutil
import subprocess
import sys
import time

files = sys.argv[1].rstrip("/")
vhost = sys.argv[2] if len(sys.argv) > 2 else "/etc/nginx/sites-available/klap"

BLOCK = ["location /_space_files/ {",
         "    internal;",
         "    alias %s/;" % files,
         "}",
         ""]

text = open(vhost, newline="").read()
if "location /_space_files/" in text:
    print("%s already has location /_space_files/ (not changed)" % vhost)
    sys.exit(0)
newline = "\r\n" if "\r\n" in text else "\n"

LOCATION = re.compile(r"^([ \t]*)location[ \t]+/[ \t]*\{", re.M)
places = [m for m in LOCATION.finditer(text)
          if "proxy_pass" in text[m.end():m.end() + 400]]
if not places:
    sys.exit("no 'location / {' with proxy_pass found in %s" % vhost)

for m in reversed(places):
    indent = m.group(1)
    block = "".join((indent + line if line else "") + newline for line in BLOCK)
    text = text[:m.start()] + block + text[m.start():]

backup = "%s.bak-%s" % (vhost, time.strftime("%Y%m%d%H%M%S"))
shutil.copy2(vhost, backup)
open(vhost, "w", newline="").write(text)
test = subprocess.run(["nginx", "-t"], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                      universal_newlines=True)  # Python 3.6 (Ubuntu 18.04)
if test.returncode != 0:
    shutil.copy2(backup, vhost)
    sys.exit("nginx -t failed, %s restored from %s:\n%s" % (vhost, backup, test.stderr))
subprocess.run(["systemctl", "reload", "nginx"], check=True)
print("added location /_space_files/ to %s, nginx reloaded (backup: %s)" % (vhost, backup))
