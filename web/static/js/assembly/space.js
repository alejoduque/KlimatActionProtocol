// A space: a group behind one secret link, with chat, shared files, notes,
// voice and video, and the history of each session.
//
// Everything that must last goes to Django. The relay (room.js) only says
// "something changed, look again", so nothing is lost when it drops a message;
// a slow poll covers those cases. Text from people is only ever put in the
// page with textContent. The one exception is the Markdown of the server,
// which render_markdown has made safe.

(function (arguman) {
    "use strict";

    var assembly = arguman.assembly = arguman.assembly || {};

    var POLL_EVERY = 30000,
        MAX_UPLOADS = 2,
        REFRESH_DELAY = 150,
        NEAR_BOTTOM = 80;

    function el(tag, className, text) {
        var element = document.createElement(tag);
        if (className) {
            element.className = className;
        }
        if (text !== undefined && text !== null) {
            element.textContent = text;
        }
        return element;
    }

    function button(className, text, handler) {
        var element = el("button", className, text);
        element.type = "button";
        if (handler) {
            element.addEventListener("click", handler);
        }
        return element;
    }

    function $(id) {
        return document.getElementById(id);
    }

    function storage(key, value) {
        try {
            if (value === undefined) {
                return sessionStorage.getItem(key);
            }
            if (value === null) {
                sessionStorage.removeItem(key);
            } else {
                sessionStorage.setItem(key, value);
            }
        } catch (e) {
            return null;
        }
    }

    function formatSize(bytes) {
        if (bytes < 1024) {
            return bytes + " B";
        }
        if (bytes < 1024 * 1024) {
            return Math.round(bytes / 1024) + " KB";
        }
        return (bytes / 1024 / 1024).toFixed(1) + " MB";
    }

    function formatTime(iso) {
        var date = new Date(iso);
        return date.toLocaleDateString() + " " +
            date.toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"});
    }

    function hasFiles(event) {
        var types = event.dataTransfer && event.dataTransfer.types;
        return types && Array.prototype.indexOf.call(types, "Files") !== -1;
    }

    function Space(config) {
        this.config = config;
        this.urls = config.urls;
        this.name = config.name;
        this.state = {sessions: [], categories: [], current: null};
        this.sessionId = null;
        this.lastMessage = 0;
        this.uploads = [];
        this.activeUploads = 0;
        this.noteTakers = {};
        this.takingNotes = false;
        this.timers = {};
    }

    Space.prototype = {
        start: function () {
            var _this = this, config = this.config;

            var room = this.room = new assembly.Room({
                room: config.room, wsUrl: config.wsUrl,
                iceServers: config.iceServers, nick: this.name
            });
            this.presence = new assembly.Presence($("live-strip"), {
                room: room,
                name: this.name,
                onName: function (name) {
                    _this.name = name;
                },
                writingLabel: function (id) {
                    return _this.isTakingNotes(id) ? gettext("taking notes") : null;
                },
                onGoto: function () {}
            });
            this.pad = new assembly.Pad({
                room: room,
                textarea: $("pad-text"),
                csrfToken: config.csrfToken,
                url: function (session) {
                    return _this.urlFor("pad", session);
                },
                onStatus: function (text) {
                    $("pad-status").textContent = text;
                }
            });

            this.bindRoom();
            this.bindPage();
            this.bindChat();
            this.bindLibrary();
            this.bindPadHistory();
            this.bindAnarlog();
            this.refreshState().then(function () {
                _this.loadChat(true);
                _this.loadLibrary();
            });
            room.connect();
            setInterval(function () {
                _this.refreshAll();
            }, POLL_EVERY);
        },

        urlFor: function (name, id) {
            return this.urls[name].replace("{id}", id);
        },

        // --------------------------------------------------------- requests

        request: function (url, options) {
            options.credentials = "same-origin";
            return fetch(url, options).then(function (response) {
                return response.json().catch(function () {
                    return {};
                }).then(function (data) {
                    if (!response.ok) {
                        throw new Error(data.error || gettext("That did not work. Try again."));
                    }
                    return data;
                });
            });
        },

        get: function (url) {
            return this.request(url, {});
        },

        post: function (url, data) {
            data = data || {};
            data.name = this.name;
            return this.request(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-CSRFToken": this.config.csrfToken
                },
                body: JSON.stringify(data)
            });
        },

        notify: function (text) {
            var note = $("space-notice");
            note.textContent = text;
            note.hidden = false;
            clearTimeout(this.timers.notice);
            this.timers.notice = setTimeout(function () {
                note.hidden = true;
            }, 6000);
        },

        fail: function (error) {
            this.notify(error.message);
        },

        // --------------------------------------------------------- the relay

        announce: function (what) {
            this.room.broadcast("changed", {what: what});
        },

        refreshSoon: function (what) {
            var _this = this;
            clearTimeout(this.timers[what]);
            this.timers[what] = setTimeout(function () {
                if (what === "chat") {
                    _this.loadChat(false);
                } else if (what === "library") {
                    _this.loadLibrary();
                    _this.loadChat(true);
                    _this.refreshState();
                } else {
                    _this.refreshState();
                }
            }, REFRESH_DELAY);
        },

        refreshAll: function () {
            this.refreshState();
            this.loadChat(false);
            this.loadLibrary();
        },

        bindRoom: function () {
            var _this = this, room = this.room;

            room.on("changed", function (from, data) {
                _this.refreshSoon(data && data.what || "library");
            });
            room.on("status", function (status) {
                if (status === "live") {
                    _this.refreshAll();  // what was missed while offline
                }
            });
            room.on("users", function (users, joined) {
                Object.keys(_this.noteTakers).forEach(function (id) {
                    if (!users[id]) {
                        delete _this.noteTakers[id];
                    }
                });
                joined.filter(function (id) {
                    return id !== room.id;
                }).forEach(function (id) {
                    // people who arrive later must also know
                    if (_this.takingNotes) {
                        room.sendTo(id, "taking-notes", {on: true});
                    }
                    if (_this.shown) {
                        room.sendTo(id, "show", {item: _this.shown});
                    }
                });
                _this.updateNoteTakers();
            });
            room.on("taking-notes", function (from, data) {
                if (data && data.on) {
                    _this.noteTakers[from] = true;
                } else {
                    delete _this.noteTakers[from];
                }
                _this.updateNoteTakers();
            });
            room.on("show", function (from, data) {
                if (data && typeof data.item === "number") {
                    var person = _this.presence.name(from) || gettext("someone");
                    _this.notify(interpolate(gettext("%(name)s shows a document to everyone"),
                                             {name: person}, true));
                    _this.openItem(data.item);
                }
            });
        },

        // ------------------------------------------------- sessions and page

        bindPage: function () {
            var _this = this;

            $("session-start").addEventListener("click", function () {
                _this.post(_this.urls.sessionNew, {title: $("session-title").value})
                    .then(function (data) {
                        $("session-title").value = "";
                        _this.announce("session");
                        _this.selectSession(data.session.id);
                        return _this.refreshState();
                    }).catch(_this.fail.bind(_this));
            });
            $("session-end").addEventListener("click", function () {
                var current = _this.state.current;
                if (!current || !window.confirm(gettext("End this session for everyone?"))) {
                    return;
                }
                _this.stopTakingNotes();
                _this.post(_this.urlFor("sessionEnd", current)).then(function () {
                    _this.announce("session");
                    return _this.refreshState();
                }).catch(_this.fail.bind(_this));
            });
            $("session-select").addEventListener("change", function (event) {
                _this.selectSession(Number(event.target.value) || null);
            });
            $("copy-link").addEventListener("click", function () {
                var link = location.origin + location.pathname;
                (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject())
                    .then(function () {
                        _this.notify(gettext("The link is copied. Whoever has it can enter this space."));
                    })
                    .catch(function () {
                        window.prompt(gettext("The link of this space:"), link);
                    });
            });
            if (this.config.canManage) {
                $("rotate-link").hidden = false;
                $("rotate-link").addEventListener("click", function () {
                    if (!window.confirm(gettext("Make a new link? The old link stops working, and everyone needs the new one. An anarlog connection is not affected."))) {
                        return;
                    }
                    _this.post(_this.urls.rotate).then(function (data) {
                        location.href = data.url;
                    }).catch(_this.fail.bind(_this));
                });
            }

            Array.prototype.forEach.call(document.querySelectorAll("[data-pane-tab]"), function (tab) {
                tab.addEventListener("click", function () {
                    _this.showPane(tab.getAttribute("data-pane-tab"));
                });
            });
            Array.prototype.forEach.call(document.querySelectorAll("[data-centre-tab]"), function (tab) {
                tab.addEventListener("click", function () {
                    _this.showCentre(tab.getAttribute("data-centre-tab"));
                });
            });
        },

        // on a phone only one pane shows at a time
        showPane: function (name) {
            $("space-panes").setAttribute("data-pane", name);
            Array.prototype.forEach.call(document.querySelectorAll("[data-pane-tab]"), function (tab) {
                tab.setAttribute("aria-pressed", tab.getAttribute("data-pane-tab") === name);
            });
        },

        showCentre: function (name) {
            $("space-centre").setAttribute("data-view", name);
            Array.prototype.forEach.call(document.querySelectorAll("[data-centre-tab]"), function (tab) {
                tab.setAttribute("aria-pressed", tab.getAttribute("data-centre-tab") === name);
            });
        },

        refreshState: function () {
            var _this = this;
            return this.get(this.urls.state).then(function (state) {
                var endedHere = _this.state.current && !state.current;
                _this.state = state;
                _this.renderState();
                if (!_this.sessionId || !_this.findSession(_this.sessionId)) {
                    _this.selectSession(state.current ||
                                        (state.sessions[0] && state.sessions[0].id) || null);
                } else if (state.current && state.current !== _this.sessionId && !_this.pinned) {
                    _this.selectSession(state.current);
                }
                if (endedHere) {
                    _this.stopTakingNotes();
                }
                _this.restoreTakingNotes();
                _this.renderSessionTools();
            }).catch(function () {});
        },

        findSession: function (id) {
            return this.state.sessions.filter(function (session) {
                return session.id === id;
            })[0];
        },

        selectSession: function (id) {
            // looking at an old session stays until the person changes it
            this.pinned = !!id && id !== this.state.current;
            if (id && id === this.sessionId) {
                return;
            }
            this.sessionId = id;
            $("session-select").value = id || "";
            $("pad-history").hidden = true;
            if (id) {
                this.pad.open(id);
            } else {
                this.pad.close();
                $("pad-text").value = "";
                $("pad-text").disabled = true;
                $("pad-status").textContent = gettext("start a session to take notes");
            }
            this.renderSessionTools();
        },

        renderState: function () {
            var state = this.state, select = $("session-select"), list = $("space-categories");

            select.textContent = "";
            if (!state.sessions.length) {
                select.appendChild(el("option", null, gettext("no sessions yet")));
            }
            state.sessions.forEach(function (session) {
                var option = el("option", null, session.title + " :: " + formatTime(session.started_at) +
                                (session.ended_at ? "" : " :: " + gettext("now")));
                option.value = session.id;
                select.appendChild(option);
            });
            select.value = this.sessionId || "";

            var filter = $("library-category"), chosen = filter.value;
            filter.textContent = "";
            var all = el("option", null, gettext("all categories"));
            all.value = "";
            filter.appendChild(all);
            list.textContent = "";
            state.categories.forEach(function (name) {
                var option = el("option", null, name);
                option.value = name;
                filter.appendChild(option);
                var suggestion = el("option");
                suggestion.value = name;
                list.appendChild(suggestion);
            });
            filter.value = chosen;

            var chatCategory = $("chat-category"), chatChosen = chatCategory.value;
            chatCategory.textContent = "";
            chatCategory.appendChild(all.cloneNode(true));
            state.categories.forEach(function (name) {
                var option = el("option", null, name);
                option.value = name;
                chatCategory.appendChild(option);
            });
            chatCategory.value = chatChosen;

            $("space-usage").textContent = interpolate(gettext("%(used)s of %(max)s"), {
                used: formatSize(state.usedBytes || 0), max: formatSize(state.maxBytes || 0)
            }, true);
            $("anarlog-hook-state").textContent = state.anarlogHook
                ? gettext("connected") : gettext("not connected");
        },

        renderSessionTools: function () {
            var current = this.state.current;
            $("session-start-tools").hidden = !!current;
            $("session-end").hidden = !current;
            var selected = !!this.sessionId;
            $("session-export").hidden = !selected;
            $("session-log").hidden = !selected;
            if (selected) {
                $("session-export").href = this.urlFor("sessionExport", this.sessionId);
                $("session-log").href = this.urls.log + "?session=" + this.sessionId;
            }
            $("notes-toggle").disabled = !current;
            $("notes-toggle").textContent = this.takingNotes
                ? gettext("I stopped taking notes") : gettext("I'm taking notes");
            $("notes-toggle").setAttribute("aria-pressed", this.takingNotes);
            $("notes-need-session").hidden = !!current;
            $("anarlog-import").disabled = !selected;
        },

        // ------------------------------------------------------------- cards

        // a document, in the chat and in the library
        card: function (item) {
            var _this = this, card = el("div", "doc-card");
            card.setAttribute("data-kind", item.kind);

            if (item.file && item.mime.indexOf("image/") === 0) {
                var preview = el("img", "doc-preview");
                preview.loading = "lazy";
                preview.alt = item.title;
                preview.src = item.file;
                preview.addEventListener("click", function () {
                    _this.openItem(item.id);
                });
                card.appendChild(preview);
            }

            var title = el("div", "doc-title");
            title.appendChild(el("span", "doc-kind", "[" + this.kindLabel(item.kind) + "]"));
            title.appendChild(document.createTextNode(" "));
            title.appendChild(button("doc-open link", item.title, function () {
                _this.openItem(item.id);
            }));
            card.appendChild(title);

            var details = [];
            if (item.size) {
                details.push(formatSize(item.size));
            }
            if (item.url) {
                details.push(item.url);
            }
            details.push(item.author || gettext("someone"));
            card.appendChild(el("div", "doc-meta", details.join(" :: ")));

            card.appendChild(this.categoryLine(item));
            return card;
        },

        kindLabel: function (kind) {
            var found = this.config.kinds.filter(function (entry) {
                return entry.kind === kind;
            })[0];
            return found ? found.label : kind;
        },

        categoryLine: function (item) {
            var _this = this, line = el("div", "doc-categories");

            item.categories.forEach(function (name) {
                line.appendChild(button("chip is-set", name, function () {
                    _this.setCategories(item, item.categories.filter(function (other) {
                        return other !== name;
                    }));
                }));
            });
            item.suggested.filter(function (name) {
                return item.categories.indexOf(name) === -1;
            }).forEach(function (name) {
                var chip = button("chip is-suggested", "+ " + name, function () {
                    _this.setCategories(item, item.categories.concat([name]));
                });
                chip.title = gettext("suggested category");
                line.appendChild(chip);
            });

            var add = button("chip", gettext("+ category"), function () {
                var input = el("input", "chip-input");
                input.setAttribute("list", "space-categories");
                input.maxLength = 40;
                input.setAttribute("aria-label", gettext("category"));
                input.addEventListener("keydown", function (event) {
                    if (event.key === "Enter" && input.value.trim()) {
                        _this.setCategories(item, item.categories.concat([input.value.trim()]));
                    } else if (event.key === "Escape") {
                        input.replaceWith(add);
                    }
                });
                add.replaceWith(input);
                input.focus();
            });
            line.appendChild(add);
            return line;
        },

        setCategories: function (item, names) {
            var _this = this;
            this.post(this.urlFor("item", item.id), {categories: names}).then(function () {
                _this.announce("library");
                _this.loadLibrary();
                _this.loadChat(true);
                _this.refreshState();
                if (_this.openedItem === item.id) {
                    _this.openItem(item.id, true);
                }
            }).catch(this.fail.bind(this));
        },

        // -------------------------------------------------------------- chat

        bindChat: function () {
            var _this = this, input = $("chat-input"), pane = $("chat-pane");

            $("chat-form").addEventListener("submit", function (event) {
                event.preventDefault();
                _this.sendMessage();
            });
            input.addEventListener("keydown", function (event) {
                if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                    event.preventDefault();
                    _this.sendMessage();
                }
            });
            $("chat-attach").addEventListener("click", function () {
                $("chat-file").click();
            });
            $("chat-file").addEventListener("change", function (event) {
                _this.addUploads(event.target.files, {chat: true});
                event.target.value = "";
            });
            ["chat-search", "chat-kind", "chat-category", "chat-person"].forEach(function (id) {
                $(id).addEventListener("change", function () {
                    _this.loadChat(true);
                });
            });

            this.dropZone(pane, {chat: true});

            // a screenshot pasted anywhere on the page goes to the chat
            document.addEventListener("paste", function (event) {
                var files = event.clipboardData && event.clipboardData.files;
                if (files && files.length) {
                    event.preventDefault();
                    _this.addUploads(files, {chat: true, pasted: true});
                    _this.showPane("chat");
                }
            });
        },

        dropZone: function (zone, options) {
            var _this = this, depth = 0;
            zone.addEventListener("dragenter", function (event) {
                if (hasFiles(event)) {
                    event.preventDefault();
                    depth++;
                    zone.classList.add("is-dropping");
                }
            });
            zone.addEventListener("dragover", function (event) {
                if (hasFiles(event)) {
                    event.preventDefault();
                }
            });
            zone.addEventListener("dragleave", function () {
                depth = Math.max(0, depth - 1);
                if (!depth) {
                    zone.classList.remove("is-dropping");
                }
            });
            zone.addEventListener("drop", function (event) {
                if (hasFiles(event)) {
                    event.preventDefault();
                    depth = 0;
                    zone.classList.remove("is-dropping");
                    _this.addUploads(event.dataTransfer.files, options);
                }
            });
        },

        chatFiltered: function () {
            return ["chat-search", "chat-kind", "chat-category", "chat-person"].some(function (id) {
                return $(id).value;
            });
        },

        chatQuery: function () {
            var parts = [];
            [["q", "chat-search"], ["kind", "chat-kind"], ["category", "chat-category"],
             ["person", "chat-person"]].forEach(function (pair) {
                if ($(pair[1]).value) {
                    parts.push(pair[0] + "=" + encodeURIComponent($(pair[1]).value));
                }
            });
            return parts;
        },

        loadChat: function (whole) {
            var _this = this, query = this.chatQuery();
            if (this.chatFiltered()) {
                whole = true;
            }
            if (!whole) {
                query.push("after=" + this.lastMessage);
            }
            var serial = this.chatSerial = (this.chatSerial || 0) + 1;
            return this.get(this.urls.chat + (query.length ? "?" + query.join("&") : ""))
                .then(function (data) {
                    if (serial === _this.chatSerial) {
                        _this.renderChat(data.messages, whole);
                    }
                }).catch(function () {});
        },

        renderChat: function (messages, whole) {
            var list = $("chat-messages"),
                stay = list.scrollHeight - list.scrollTop - list.clientHeight < NEAR_BOTTOM,
                scroll = list.scrollTop;

            if (whole) {
                list.textContent = "";
                this.lastMessage = 0;
            }
            messages.forEach(function (message) {
                if (!list.querySelector('[data-message="' + message.id + '"]')) {
                    list.appendChild(this.messageElement(message));
                }
                this.lastMessage = Math.max(this.lastMessage, message.id);
                this.rememberPerson(message.author);
            }, this);
            list.scrollTop = stay ? list.scrollHeight : scroll;
        },

        rememberPerson: function (name) {
            var select = $("chat-person");
            if (name && !Array.prototype.some.call(select.options, function (option) {
                return option.value === name;
            })) {
                var option = el("option", null, name);
                option.value = name;
                select.appendChild(option);
            }
        },

        messageElement: function (message) {
            var row = el("div", "chat-message");
            row.setAttribute("data-message", message.id);
            var head = el("div", "chat-head");
            head.appendChild(el("strong", null, message.author || gettext("someone")));
            head.appendChild(el("span", "chat-time", formatTime(message.created_at)));
            row.appendChild(head);
            if (message.text) {
                row.appendChild(el("div", "chat-text", message.text));
            }
            message.items.forEach(function (item) {
                row.appendChild(this.card(item));
            }, this);
            return row;
        },

        sendMessage: function () {
            var _this = this, input = $("chat-input"), text = input.value.trim();
            if (!text) {
                return;
            }
            input.value = "";
            this.post(this.urls.chatPost, {text: text, session: this.state.current})
                .then(function (data) {
                    _this.renderChat([data.message], false);
                    var list = $("chat-messages");
                    list.scrollTop = list.scrollHeight;
                    _this.announce(data.message.items.length ? "library" : "chat");
                    if (data.message.items.length) {
                        _this.loadLibrary();
                    }
                })
                .catch(function (error) {
                    input.value = text;
                    _this.fail(error);
                });
        },

        // ----------------------------------------------------------- uploads

        addUploads: function (files, options) {
            Array.prototype.forEach.call(files, function (file) {
                var upload = {file: file, options: options, row: el("div", "upload-row")};
                upload.label = el("span", "upload-name", file.name || gettext("pasted image"));
                upload.bar = el("progress", "upload-bar");
                upload.bar.max = 100;
                upload.bar.value = 0;
                upload.cancel = button("link", gettext("cancel"), this.cancelUpload.bind(this, upload));
                upload.row.appendChild(upload.label);
                upload.row.appendChild(upload.bar);
                upload.row.appendChild(upload.cancel);
                $("chat-uploads").appendChild(upload.row);

                if (file.size > this.config.maxFileBytes) {
                    this.uploadFailed(upload, interpolate(gettext("too big :: the limit is %(max)s"),
                                                          {max: formatSize(this.config.maxFileBytes)}, true));
                } else {
                    this.uploads.push(upload);
                }
            }, this);
            this.nextUpload();
        },

        cancelUpload: function (upload) {
            this.uploads = this.uploads.filter(function (other) {
                return other !== upload;
            });
            if (upload.xhr) {
                upload.xhr.abort();
            }
            upload.row.remove();
        },

        uploadFailed: function (upload, message) {
            upload.row.classList.add("is-error");
            upload.bar.remove();
            upload.row.insertBefore(el("span", "upload-error", message), upload.cancel);
            upload.cancel.textContent = gettext("close");
        },

        nextUpload: function () {
            while (this.activeUploads < MAX_UPLOADS && this.uploads.length) {
                this.send(this.uploads.shift());
            }
        },

        send: function (upload) {
            var _this = this, xhr = upload.xhr = new XMLHttpRequest(), form = new FormData(),
                options = upload.options, file = upload.file;

            this.activeUploads++;
            var filename = file.name;
            if (options.pasted && (!filename || filename === "image.png")) {
                filename = "screenshot-" + new Date().toISOString().replace(/[:.]/g, "-") + ".png";
            }
            form.append("file", file, filename);
            form.append("name", this.name);
            if (this.state.current) {
                form.append("session", this.state.current);
            }
            if (options.chat) {
                form.append("chat", "1");
            }
            if (options.pasted) {
                form.append("pasted", "1");
            }

            function finished() {
                upload.xhr = null;
                _this.activeUploads--;
                _this.nextUpload();
            }

            xhr.open("POST", this.urls.upload);
            xhr.setRequestHeader("X-CSRFToken", this.config.csrfToken);
            xhr.upload.onprogress = function (event) {
                if (event.lengthComputable) {
                    upload.bar.value = 100 * event.loaded / event.total;
                }
            };
            xhr.onload = function () {
                var data = {};
                try {
                    data = JSON.parse(xhr.responseText);
                } catch (e) {
                    data = {};
                }
                if (xhr.status >= 200 && xhr.status < 300) {
                    upload.row.remove();
                    if (data.message) {
                        _this.renderChat([data.message], false);
                    }
                    _this.announce("library");
                    _this.loadLibrary();
                    _this.refreshState();
                } else if (xhr.status === 413 && !data.error) {
                    _this.uploadFailed(upload, gettext("The file is too big."));
                } else {
                    _this.uploadFailed(upload, data.error || gettext("That did not work. Try again."));
                }
                finished();
            };
            xhr.onerror = function () {
                _this.uploadFailed(upload, gettext("The connection failed."));
                finished();
            };
            xhr.onabort = finished;
            xhr.send(form);
        },

        // ----------------------------------------------------------- library

        bindLibrary: function () {
            var _this = this;

            ["library-search", "library-kind", "library-category", "library-session"].forEach(function (id) {
                $(id).addEventListener("change", _this.loadLibrary.bind(_this));
            });
            this.dropZone($("library-pane"), {});
            $("library-attach").addEventListener("click", function () {
                $("library-file").click();
            });
            $("library-file").addEventListener("change", function (event) {
                _this.addUploads(event.target.files, {});
                event.target.value = "";
            });
            $("library-add-form").addEventListener("submit", function (event) {
                event.preventDefault();
                var value = $("library-add-text").value.trim(),
                    title = $("library-add-title").value.trim(),
                    isLink = /^https?:\/\//i.test(value),
                    data = isLink ? {url: value, title: title} : {body: value, title: title};
                data.session = _this.state.current;
                _this.post(_this.urls.itemNew, data).then(function () {
                    $("library-add-text").value = "";
                    $("library-add-title").value = "";
                    _this.announce("library");
                    _this.loadLibrary();
                }).catch(_this.fail.bind(_this));
            });
        },

        loadLibrary: function () {
            var _this = this, parts = [];
            [["q", "library-search"], ["kind", "library-kind"], ["category", "library-category"]]
                .forEach(function (pair) {
                    if ($(pair[1]).value) {
                        parts.push(pair[0] + "=" + encodeURIComponent($(pair[1]).value));
                    }
                });
            if ($("library-session").checked && this.sessionId) {
                parts.push("session=" + this.sessionId);
            }
            var serial = this.librarySerial = (this.librarySerial || 0) + 1;
            return this.get(this.urls.items + (parts.length ? "?" + parts.join("&") : ""))
                .then(function (data) {
                    if (serial === _this.librarySerial) {
                        _this.renderLibrary(data.items);
                    }
                }).catch(function () {});
        },

        renderLibrary: function (items) {
            var list = $("library-items");
            list.textContent = "";
            if (!items.length) {
                list.appendChild(el("p", "space-empty",
                    gettext("Nothing here yet. Drop files here or in the chat.")));
            }
            items.forEach(function (item) {
                list.appendChild(this.card(item));
            }, this);
        },

        // ---------------------------------------------------------- document

        openItem: function (id, keepEditing) {
            var _this = this;
            return this.get(this.urlFor("item", id)).then(function (data) {
                _this.openedItem = id;
                _this.renderItem(data, keepEditing);
                _this.showCentre("document");
                _this.showPane("centre");
            }).catch(this.fail.bind(this));
        },

        renderItem: function (data) {
            var _this = this, item = data.item, view = $("document-view");
            view.textContent = "";

            var head = el("div", "document-head");
            head.appendChild(el("h3", null, item.title));
            head.appendChild(el("p", "doc-meta",
                [this.kindLabel(item.kind), item.author || gettext("someone"),
                 formatTime(item.created_at)].join(" :: ")));
            view.appendChild(head);

            var actions = el("div", "document-actions");
            actions.appendChild(button("link", gettext("show to everyone"), function () {
                _this.shown = item.id;
                _this.room.broadcast("show", {item: item.id});
                _this.notify(gettext("Everyone in this space now sees this document."));
            }));
            actions.appendChild(button("link", gettext("cite in notes"), function () {
                _this.pad.insertAtCaret("[" + item.title + "] (#" + item.id + ")\n");
                _this.showCentre("notes");
            }));
            if (this.sessionId && item.session !== this.sessionId) {
                actions.appendChild(button("link", gettext("add to this session"), function () {
                    _this.post(_this.urlFor("itemSession", item.id), {session: _this.sessionId})
                        .then(function () {
                            _this.announce("library");
                            _this.openItem(item.id);
                            _this.loadLibrary();
                        }).catch(_this.fail.bind(_this));
                }));
            }
            if (item.file) {
                var download = el("a", null, gettext("download"));
                download.href = item.file + "?download=1";
                actions.appendChild(download);
            }
            if (data.canRemove) {
                actions.appendChild(button("link", gettext("remove"), function () {
                    if (!window.confirm(gettext("Remove this document from the space?"))) {
                        return;
                    }
                    _this.post(_this.urlFor("itemRemove", item.id)).then(function () {
                        _this.announce("library");
                        view.textContent = "";
                        _this.openedItem = null;
                        _this.showCentre("notes");
                        _this.loadLibrary();
                        _this.loadChat(true);
                    }).catch(_this.fail.bind(_this));
                }));
            }
            view.appendChild(actions);
            view.appendChild(this.categoryLine(item));

            var content = el("div", "document-content");
            if (item.url) {
                var link = el("a", "document-link", item.url);
                link.href = item.url;
                link.target = "_blank";
                link.rel = "noopener noreferrer";
                content.appendChild(link);
            } else if (item.file && item.mime.indexOf("image/") === 0) {
                var image = el("img", "document-image");
                image.alt = item.title;
                image.src = item.file;
                content.appendChild(image);
            } else if (item.mime === "application/pdf") {
                // the viewer of the browser; it does not open in a sandboxed frame
                var frame = el("iframe", "document-frame");
                frame.title = item.title;
                frame.src = item.file;
                content.appendChild(frame);
            } else if (item.file) {
                content.appendChild(el("p", "space-empty",
                    gettext("KLAP does not show this type of file. Download it to read it.")));
            } else {
                var rendered = el("div", "document-text");
                rendered.innerHTML = item.html;  // made safe by render_markdown
                content.appendChild(rendered);
            }
            view.appendChild(content);

            if (item.editable) {
                view.appendChild(this.itemEditor(item));
            }
            view.appendChild(this.itemHistory(data.history));
        },

        itemEditor: function (item) {
            var _this = this, details = el("details", "document-edit");
            details.appendChild(el("summary", null, gettext("edit")));
            var title = el("input");
            title.value = item.title;
            title.maxLength = 255;
            title.setAttribute("aria-label", gettext("title"));
            var body = el("textarea");
            body.value = item.body;
            body.rows = 12;
            body.setAttribute("aria-label", gettext("text"));
            details.appendChild(title);
            details.appendChild(body);
            details.appendChild(button("", gettext("save"), function () {
                _this.post(_this.urlFor("item", item.id), {title: title.value, body: body.value})
                    .then(function () {
                        _this.announce("library");
                        _this.openItem(item.id);
                        _this.loadLibrary();
                    }).catch(_this.fail.bind(_this));
            }));
            this.itemEditorBody = body;
            return details;
        },

        itemHistory: function (history) {
            var details = el("details", "document-history");
            details.appendChild(el("summary", null,
                interpolate(gettext("history (%(count)s)"), {count: history.length}, true)));
            history.forEach(function (revision) {
                var row = el("details", "revision");
                row.appendChild(el("summary", null, formatTime(revision.created_at) + " :: " +
                                   (revision.author || gettext("someone"))));
                row.appendChild(el("p", "doc-meta", revision.title +
                                   (revision.categories.length ? " :: " + revision.categories.join(", ") : "")));
                if (revision.body) {
                    row.appendChild(el("pre", "revision-text", revision.body));
                }
                details.appendChild(row);
            });
            return details;
        },

        // -------------------------------------------------------- pad history

        bindPadHistory: function () {
            var _this = this, panel = $("pad-history"), slider = $("pad-slider");

            $("pad-history-toggle").addEventListener("click", function () {
                if (!panel.hidden) {
                    panel.hidden = true;
                    return;
                }
                if (!_this.sessionId) {
                    return;
                }
                _this.get(_this.urlFor("padRevisions", _this.sessionId)).then(function (data) {
                    // oldest on the left
                    _this.revisions = data.revisions.reverse();
                    panel.hidden = false;
                    slider.max = Math.max(_this.revisions.length - 1, 0);
                    slider.value = slider.max;
                    _this.showRevision();
                }).catch(_this.fail.bind(_this));
            });
            slider.addEventListener("input", this.showRevision.bind(this));
            $("pad-restore").addEventListener("click", function () {
                if (_this.revisionText !== undefined &&
                        window.confirm(gettext("Bring this version back? It becomes a new edit for everyone."))) {
                    _this.pad.replaceText(_this.revisionText);
                    _this.pad.render();
                    panel.hidden = true;
                }
            });
        },

        showRevision: function () {
            var _this = this, revision = this.revisions[Number($("pad-slider").value)];
            $("pad-restore").disabled = !revision;
            if (!revision) {
                $("pad-revision-time").textContent = gettext("no saved versions yet");
                $("pad-revision-text").textContent = "";
                this.revisionText = undefined;
                return;
            }
            $("pad-revision-time").textContent = formatTime(revision.created_at);
            this.get(this.urlFor("padRevisions", this.sessionId) + "/" + revision.id)
                .then(function (data) {
                    _this.revisionText = data.text;
                    $("pad-revision-text").textContent = data.text;
                }).catch(this.fail.bind(this));
        },

        // ----------------------------------------------------------- anarlog

        isTakingNotes: function (id) {
            return id === "me" ? this.takingNotes : !!this.noteTakers[id];
        },

        updateNoteTakers: function () {
            var _this = this,
                names = Object.keys(this.noteTakers).map(function (id) {
                    return _this.presence.name(id) || gettext("someone");
                });
            if (this.takingNotes) {
                names.unshift(gettext("you"));
            }
            var banner = $("notes-banner");
            banner.hidden = !names.length;
            banner.textContent = names.length ? interpolate(
                gettext("recording notes on their computer :: %(names)s"),
                {names: names.join(", ")}, true) : "";
            Object.keys(this.presence.tiles).forEach(this.presence.updateTile, this.presence);
        },

        setTakingNotes: function (on) {
            var current = this.state.current;
            if (on && !current) {
                return;
            }
            this.takingNotes = on;
            this.notesSession = on ? current : null;
            storage("klap.space.notes." + this.config.room, on ? String(current) : null);
            this.room.broadcast("taking-notes", {on: on});
            this.updateNoteTakers();
            this.renderSessionTools();
        },

        toggleTakingNotes: function () {
            var _this = this, on = !this.takingNotes,
                session = on ? this.state.current : this.notesSession;
            this.setTakingNotes(on);
            if (session) {
                this.post(this.urlFor("takingNotes", session), {on: on})
                    .catch(_this.fail.bind(_this));
            }
        },

        stopTakingNotes: function () {
            if (this.takingNotes) {
                this.toggleTakingNotes();
            }
        },

        // a reload does not stop the recording on the computer
        restoreTakingNotes: function () {
            if (!this.takingNotes && this.state.current &&
                    storage("klap.space.notes." + this.config.room) === String(this.state.current)) {
                this.setTakingNotes(true);
            }
        },

        bindAnarlog: function () {
            var _this = this, input = $("anarlog-markdown");

            $("notes-toggle").addEventListener("click", this.toggleTakingNotes.bind(this));
            $("anarlog-transcript").addEventListener("change", this.previewAnarlog.bind(this));
            input.addEventListener("input", function () {
                clearTimeout(_this.timers.preview);
                _this.timers.preview = setTimeout(_this.previewAnarlog.bind(_this), 400);
            });

            function readFile(file) {
                if (!file) {
                    return;
                }
                var reader = new FileReader();
                reader.onload = function () {
                    input.value = reader.result;
                    _this.previewAnarlog();
                };
                reader.readAsText(file);
            }

            $("anarlog-file").addEventListener("change", function (event) {
                readFile(event.target.files[0]);
                event.target.value = "";
            });
            var zone = $("anarlog-drop");
            zone.addEventListener("dragover", function (event) {
                if (hasFiles(event)) {
                    event.preventDefault();
                }
            });
            zone.addEventListener("drop", function (event) {
                if (hasFiles(event)) {
                    event.preventDefault();
                    event.stopPropagation();
                    readFile(event.dataTransfer.files[0]);
                }
            });

            $("anarlog-import").addEventListener("click", function () {
                if (!_this.sessionId || !input.value.trim()) {
                    return;
                }
                _this.post(_this.urlFor("anarlogImport", _this.sessionId), {
                    markdown: input.value,
                    transcript: $("anarlog-transcript").checked
                }).then(function () {
                    input.value = "";
                    $("anarlog-preview").textContent = "";
                    $("anarlog-transcript-line").hidden = true;
                    _this.notify(gettext("The summary is in this session."));
                    _this.announce("library");
                    _this.loadLibrary();
                }).catch(_this.fail.bind(_this));
            });

            $("anarlog-hook-url").value = this.config.hookUrl;
            $("anarlog-hook-save").addEventListener("click", function () {
                _this.post(_this.urls.anarlogSettings, {
                    secret: $("anarlog-hook-secret").value,
                    transcript: $("anarlog-hook-transcript").checked
                }).then(function () {
                    $("anarlog-hook-secret").value = "";
                    _this.notify(gettext("Anarlog is connected. Click Test in anarlog to check."));
                    _this.refreshState();
                }).catch(_this.fail.bind(_this));
            });
        },

        previewAnarlog: function () {
            var input = $("anarlog-markdown"), preview = $("anarlog-preview");
            if (!this.sessionId || !input.value.trim()) {
                preview.textContent = "";
                $("anarlog-transcript-line").hidden = true;
                return;
            }
            this.post(this.urlFor("anarlogImport", this.sessionId), {
                markdown: input.value,
                transcript: $("anarlog-transcript").checked,
                preview: true
            }).then(function (data) {
                preview.innerHTML = data.html;  // made safe by render_markdown
                $("anarlog-transcript-line").hidden = !data.hasTranscript;
            }).catch(this.fail.bind(this));
        }
    };

    assembly.Space = Space;
})(window.arguman = window.arguman || {});
