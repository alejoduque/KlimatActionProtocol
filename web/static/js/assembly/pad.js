// The notes of a session: one text that everyone edits at once, like
// etherpad, without a server that understands it.
//
// Yjs (lib/yjs-*.min.js) merges the edits in each browser. Updates go through
// the chatb relay (room.js), which keeps nothing and may drop messages for a
// slow client, so browsers also compare what they have every few seconds.
// One browser sends the merged state to Django from time to time; those saves
// are the history of the notes.

(function (arguman) {
    "use strict";

    var assembly = arguman.assembly = arguman.assembly || {};

    var CHUNK = 45000,          // base64 characters; the relay takes 64 KiB
        COMPARE_EVERY = 15000,
        SAVE_QUIET = 30000,     // after the last edit
        SAVE_LATEST = 120000,   // even when the typing does not stop
        LOCAL = "local", REMOTE = "remote";

    function toBase64(bytes) {
        var binary = "", size = 0x8000;
        for (var i = 0; i < bytes.length; i += size) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + size));
        }
        return btoa(binary);
    }

    function fromBase64(text) {
        var binary = atob(text), bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    function isLowSurrogate(text, index) {
        var code = text.charCodeAt(index);
        return code >= 0xDC00 && code <= 0xDFFF;
    }

    // the one change that turns before into after; never cuts an emoji
    function difference(before, after) {
        var start = 0,
            limit = Math.min(before.length, after.length);
        while (start < limit && before[start] === after[start]) {
            start++;
        }
        if (start > 0 && (isLowSurrogate(before, start) || isLowSurrogate(after, start))) {
            start--;
        }
        var end = 0;
        while (end < limit - start &&
               before[before.length - 1 - end] === after[after.length - 1 - end]) {
            end++;
        }
        if (end > 0 && (isLowSurrogate(before, before.length - end) ||
                        isLowSurrogate(after, after.length - end))) {
            end--;
        }
        return {
            index: start,
            remove: before.length - start - end,
            insert: after.slice(start, after.length - end)
        };
    }

    // where a caret goes when other people's edits arrive
    function moveCaret(position, delta) {
        var index = 0;
        delta.forEach(function (op) {
            if (op.retain) {
                index += op.retain;
            } else if (op.insert) {
                if (index < position) {
                    position += op.insert.length;
                }
                index += op.insert.length;
            } else if (op.delete) {
                if (index < position) {
                    position -= Math.min(op.delete, position - index);
                }
            }
        });
        return position;
    }

    // options: room, textarea, csrfToken, url(sessionId), onStatus(text)
    function Pad(options) {
        this.room = options.room;
        this.textarea = options.textarea;
        this.options = options;
        this.session = null;
        this.doc = null;
        this.parts = {};
        this.nextPart = 0;
        this.bind();
    }

    Pad.prototype = {
        bind: function () {
            var _this = this, room = this.room, textarea = this.textarea;

            textarea.addEventListener("compositionstart", function () {
                _this.composing = true;
            });
            textarea.addEventListener("compositionend", function () {
                _this.composing = false;
                _this.fromTextarea();
                _this.render();
            });
            textarea.addEventListener("input", function () {
                if (!_this.composing) {
                    _this.fromTextarea();
                }
            });

            room.on("pad-update", function (from, data) {
                if (_this.isCurrent(data)) {
                    _this.receive(from, data);
                }
            });
            room.on("pad-compare", function (from, data) {
                if (_this.isCurrent(data)) {
                    _this.answerCompare(from, data);
                }
            });
            room.on("users", function (users, joined) {
                joined.filter(function (id) {
                    return id !== room.id;
                }).forEach(_this.compareWith, _this);
            });

            setInterval(function () {
                var others = _this.others();
                if (others.length) {
                    _this.compareWith(others[Math.floor(Math.random() * others.length)]);
                }
            }, COMPARE_EVERY);

            window.addEventListener("pagehide", this.saveOnLeaving.bind(this));
        },

        isCurrent: function (data) {
            return this.doc && !this.loading && data && data.s === this.session;
        },

        others: function () {
            var room = this.room;
            return Object.keys(room.users).filter(function (id) {
                return id !== room.id;
            });
        },

        status: function (text) {
            this.options.onStatus(text);
        },

        // ------------------------------------------------------ one session

        open: function (session) {
            var _this = this;
            this.saveOnLeaving();
            this.close();
            this.session = session;
            this.loading = true;
            this.textarea.value = "";
            this.textarea.disabled = true;
            this.status(gettext("loading…"));

            var doc = this.doc = new Y.Doc(),
                text = this.text = doc.getText("notes");
            text.observe(function (event, transaction) {
                if (transaction.origin !== LOCAL) {
                    _this.applyToTextarea(event.delta);
                }
            });
            doc.on("update", function (update, origin) {
                if (origin !== REMOTE) {
                    _this.send(update);
                }
                _this.markDirty();
            });

            return fetch(this.options.url(session), {credentials: "same-origin"})
                .then(function (response) {
                    return response.json();
                })
                .then(function (data) {
                    if (_this.doc !== doc) {
                        return;
                    }
                    if (data.state) {
                        Y.applyUpdate(doc, fromBase64(data.state), REMOTE);
                    }
                    _this.loading = false;
                    _this.dirty = false;
                    _this.render();
                    _this.textarea.disabled = false;
                    _this.status(gettext("saved"));
                    _this.others().forEach(_this.compareWith, _this);
                })
                .catch(function () {
                    if (_this.doc === doc) {
                        _this.status(gettext("the notes did not load"));
                    }
                });
        },

        close: function () {
            clearTimeout(this.quietTimer);
            clearTimeout(this.latestTimer);
            this.latestTimer = null;
            if (this.doc) {
                this.doc.destroy();
            }
            this.doc = this.text = null;
            this.session = null;
            this.dirty = false;
        },

        // -------------------------------------------------- text and textarea

        fromTextarea: function () {
            this.replaceText(this.textarea.value);
        },

        // also how an older version comes back: as a new edit
        replaceText: function (value) {
            if (!this.text) {
                return;
            }
            var _this = this,
                change = difference(this.shown || "", value);
            if (!change.remove && !change.insert) {
                return;
            }
            this.shown = value;
            this.doc.transact(function () {
                if (change.remove) {
                    _this.text.delete(change.index, change.remove);
                }
                if (change.insert) {
                    _this.text.insert(change.index, change.insert);
                }
            }, LOCAL);
        },

        render: function () {
            if (this.text) {
                this.shown = this.textarea.value = this.text.toString();
            }
        },

        applyToTextarea: function (delta) {
            if (this.composing) {
                return;  // compositionend shows it; a new value would break the word
            }
            var textarea = this.textarea,
                start = moveCaret(textarea.selectionStart, delta),
                end = moveCaret(textarea.selectionEnd, delta),
                scroll = textarea.scrollTop;
            this.render();
            textarea.setSelectionRange(start, end);
            textarea.scrollTop = scroll;
        },

        insertAtCaret: function (value) {
            var textarea = this.textarea;
            if (textarea.disabled) {
                return;
            }
            textarea.setRangeText(value, textarea.selectionStart, textarea.selectionEnd, "end");
            this.fromTextarea();
            textarea.focus();
        },

        // ---------------------------------------------------------- the wire

        send: function (update, to) {
            var room = this.room, session = this.session, data = toBase64(update);

            function deliver(message) {
                if (to) {
                    room.sendTo(to, "pad-update", message);
                } else {
                    room.broadcast("pad-update", message);
                }
            }

            if (data.length <= CHUNK) {
                deliver({s: session, d: data});
                return;
            }
            var part = room.id + "-" + (this.nextPart++),
                count = Math.ceil(data.length / CHUNK);
            for (var i = 0; i < count; i++) {
                deliver({s: session, p: part, i: i, n: count,
                         d: data.slice(i * CHUNK, (i + 1) * CHUNK)});
            }
        },

        receive: function (from, data) {
            if (typeof data.d !== "string") {
                return;
            }
            var whole = data.d;
            if (data.p) {
                var key = from + ":" + data.p,
                    parts = this.parts[key] = this.parts[key] || [];
                parts[data.i] = data.d;
                for (var i = 0; i < data.n; i++) {
                    if (parts[i] === undefined) {
                        return;
                    }
                }
                delete this.parts[key];
                whole = parts.join("");
            }
            try {
                Y.applyUpdate(this.doc, fromBase64(whole), REMOTE);
            } catch (error) {
                console.warn("pad: bad update: " + error.message);
            }
        },

        // tell someone what we have; they answer with what we lack
        compareWith: function (id) {
            if (this.doc && !this.loading) {
                this.room.sendTo(id, "pad-compare", {
                    s: this.session,
                    v: toBase64(Y.encodeStateVector(this.doc))
                });
            }
        },

        answerCompare: function (from, data) {
            if (typeof data.v !== "string") {
                return;
            }
            var missing;
            try {
                missing = Y.encodeStateAsUpdate(this.doc, fromBase64(data.v));
            } catch (error) {
                return;
            }
            if (missing.length > 2) {  // two bytes: an empty update
                this.send(missing, from);
            }
        },

        // ------------------------------------------------------------ saving

        isSaver: function () {
            var room = this.room, ids = Object.keys(room.users).map(Number);
            return !room.id || !ids.length ||
                Number(room.id) === Math.min.apply(null, ids);
        },

        markDirty: function () {
            var _this = this;
            if (this.loading) {
                return;
            }
            this.dirty = true;
            this.status(gettext("not saved yet"));
            clearTimeout(this.quietTimer);
            this.quietTimer = setTimeout(this.save.bind(this), SAVE_QUIET);
            if (!this.latestTimer) {
                this.latestTimer = setTimeout(function () {
                    _this.latestTimer = null;
                    _this.save();
                }, SAVE_LATEST);
            }
        },

        formData: function () {
            var data = new FormData();
            data.append("csrfmiddlewaretoken", this.options.csrfToken);
            data.append("text", this.text.toString());
            data.append("state", toBase64(Y.encodeStateAsUpdate(this.doc)));
            return data;
        },

        save: function () {
            var _this = this, session = this.session;
            if (!this.dirty || !this.doc) {
                return;
            }
            if (!this.isSaver()) {
                // someone else saves this text. Stay ready: they may leave first
                this.status(gettext("another person saves these notes"));
                this.quietTimer = setTimeout(this.save.bind(this), SAVE_QUIET);
                return;
            }
            this.dirty = false;
            this.status(gettext("saving…"));
            fetch(this.options.url(session), {
                method: "POST", credentials: "same-origin", body: this.formData()
            }).then(function (response) {
                return response.ok ? response.json() : Promise.reject();
            }).then(function (result) {
                if (session !== _this.session) {
                    return;
                }
                if (result.soon) {
                    _this.markDirty();
                } else if (!_this.dirty) {
                    _this.status(gettext("saved"));
                }
            }).catch(function () {
                if (session === _this.session) {
                    _this.markDirty();
                    _this.status(gettext("not saved :: trying again"));
                }
            });
        },

        // best effort: the browser only lets a small message leave a closing page
        saveOnLeaving: function () {
            if (this.dirty && this.doc && navigator.sendBeacon) {
                navigator.sendBeacon(this.options.url(this.session), this.formData());
                this.dirty = false;
            }
        }
    };

    assembly.Pad = Pad;
    assembly.Pad.difference = difference;
    assembly.Pad.moveCaret = moveCaret;
})(window.arguman = window.arguman || {});
