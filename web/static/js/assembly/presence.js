// People on the claim page: a strip of tiles with voice, video and ascii
// video, over chatb's room relay and WebRTC mesh (room.js).
//
// The microphone and the camera stay off until a person starts them. In
// ascii mode the camera image is turned into text here (ascii.js, after
// hasciicam) and only the text frames are sent: the image never leaves the
// computer. Permasoftware style: no colour; video is shown in greys.

(function (arguman) {
    "use strict";

    var assembly = arguman.assembly = arguman.assembly || {};

    var ASCII_FPS = 8,
        RELAY_EVERY = 4,  // frames through the relay at ASCII_FPS / RELAY_EVERY
        NOTE = "Ascii sends only text. Your camera image stays on your computer.";

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

    function button(className, text, action) {
        var element = el("button", className, text);
        element.type = "button";
        if (action) {
            element.setAttribute("data-action", action);
        }
        return element;
    }

    function storage(key, value) {
        try {
            if (value === undefined) {
                return localStorage.getItem(key);
            }
            localStorage.setItem(key, value);
        } catch (e) {
            return null;
        }
    }

    // options: room, name, onName(name), writingLabel(id) -> text or null,
    // onGoto(id)
    function Presence(container, options) {
        this.container = container;
        this.room = options.room;
        this.options = options;
        this.people = {};
        this.tiles = {};
        this.asciiView = storage("klap.live.asciiView") === "1";
        this.me = {name: options.name, mic: false, cam: "off"};
        this.camTrack = null;
        // inverted (AA-lib's inversion): dark text on paper, like the rest of KLAP
        this.renderer = new assembly.ascii.Renderer({cols: 72, inversion: true});
        this.frameCount = 0;
        this.build();
        this.bind();
    }

    Presence.prototype = {
        build: function () {
            var root = this.container;
            root.textContent = "";

            var head = el("div", "strip-head");
            head.appendChild(el("strong", null, "present"));
            this.status = el("span", "strip-status", "connecting…");
            head.appendChild(this.status);
            this.toggle = button("strip-toggle link", "settings", "toggle");
            this.toggle.setAttribute("aria-expanded", "false");
            head.appendChild(this.toggle);
            root.appendChild(head);

            var controls = this.controls = el("div", "strip-controls");
            controls.hidden = true;
            var nameLabel = el("label", "strip-name");
            nameLabel.appendChild(el("span", null, "your name"));
            this.nameInput = el("input");
            this.nameInput.type = "text";
            this.nameInput.maxLength = 30;
            this.nameInput.value = this.me.name;
            nameLabel.appendChild(this.nameInput);
            controls.appendChild(nameLabel);

            this.micButton = button("media-toggle", "mic off", "mic");
            controls.appendChild(this.micButton);
            var cams = el("div", "cam-modes");
            cams.setAttribute("role", "group");
            cams.setAttribute("aria-label", "camera");
            this.camButtons = {};
            [["off", "no camera"], ["ascii", "ascii"], ["video", "video"]]
                .forEach(function (mode) {
                    var b = button("cam-mode", mode[1], "cam");
                    b.setAttribute("data-mode", mode[0]);
                    this.camButtons[mode[0]] = b;
                    cams.appendChild(b);
                }, this);
            controls.appendChild(cams);

            var asciiLabel = el("label", "ascii-view");
            this.asciiViewInput = el("input");
            this.asciiViewInput.type = "checkbox";
            this.asciiViewInput.checked = this.asciiView;
            asciiLabel.appendChild(this.asciiViewInput);
            asciiLabel.appendChild(document.createTextNode(" show all video as ascii"));
            controls.appendChild(asciiLabel);
            this.mediaNote = el("p", "strip-note", NOTE);
            controls.appendChild(this.mediaNote);
            root.appendChild(controls);

            this.tilesEl = el("div", "strip-tiles");
            root.appendChild(this.tilesEl);

            this.localVideo = el("video");
            this.localVideo.muted = true;
            this.localVideo.playsInline = true;
            this.localVideo.autoplay = true;

            this.updateControls();
            this.updateTile("me");
        },

        bind: function () {
            var _this = this, room = this.room;

            this.container.addEventListener("click", function (event) {
                var action = event.target.closest("[data-action]");
                if (!action) {
                    return;
                }
                switch (action.getAttribute("data-action")) {
                case "toggle":
                    _this.controls.hidden = !_this.controls.hidden;
                    _this.toggle.setAttribute("aria-expanded", !_this.controls.hidden);
                    break;
                case "mic":
                    _this.setMic(!_this.me.mic);
                    break;
                case "cam":
                    _this.setCam(action.getAttribute("data-mode"));
                    break;
                case "sound":
                    _this.enableSound();
                    break;
                case "goto":
                    _this.options.onGoto(action.getAttribute("data-user"));
                    break;
                }
            });

            this.nameInput.addEventListener("change", function () {
                var name = _this.nameInput.value.trim();
                if (!name) {
                    _this.nameInput.value = _this.me.name;
                    return;
                }
                _this.me.name = name;
                room.setNick(name);
                _this.sendState();
                _this.updateTile("me");
                _this.options.onName(name);
            });

            this.asciiViewInput.addEventListener("change", function () {
                _this.asciiView = _this.asciiViewInput.checked;
                storage("klap.live.asciiView", _this.asciiView ? "1" : "0");
                Object.keys(_this.tiles).forEach(_this.updateTile, _this);
                _this.updateAsciiLoop();
            });

            window.addEventListener("beforeunload", function () {
                _this.stopTrack("audio");
                _this.stopTrack("video");
            });

            room.on("status", function (status) {
                _this.connection = status;
                _this.updateStatus();
            });
            room.on("users", function (users, joined) {
                Object.keys(_this.people).forEach(function (id) {
                    if (!users[id]) {
                        _this.removePerson(id);
                    }
                });
                Object.keys(users).forEach(function (id) {
                    if (id === room.id) {
                        return;
                    }
                    var person = _this.people[id] = _this.people[id] || {mic: false, cam: "off"};
                    person.name = users[id].name || person.name || "someone";
                    _this.updateTile(id);
                });
                if (joined.length) {
                    _this.sendState();
                }
                _this.updateStatus();
            });
            room.on("left", this.removePerson.bind(this));
            room.on("state", function (from, state) {
                var person = _this.people[from] = _this.people[from] || {};
                person.mic = !!state.mic;
                person.cam = state.cam;
                person.name = state.name || person.name;
                _this.updateTile(from);
                _this.updateAsciiLoop();
            });
            room.on("ascii", function (from, frame) {
                var tile = _this.tiles[from];
                if (tile && frame && typeof frame.f === "string") {
                    tile.pre.textContent = frame.f;
                }
            });
            room.on("stream", function (from, stream) {
                // tracks also end after their person has left the room
                var tile = _this.tiles[from] || _this.updateTile(from);
                if (!tile) {
                    return;
                }
                if (tile.video.srcObject !== stream) {
                    tile.video.srcObject = stream;
                    tile.audio.srcObject = stream;
                }
                tile.audio.play().catch(function () {
                    _this.soundBlocked = true;
                    _this.updateStatus();
                });
                _this.updateTile(from);
            });
        },

        name: function (id) {
            var person = this.people[id];
            return person && person.name;
        },

        count: function () {
            return Object.keys(this.people).length + 1;
        },

        removePerson: function (id) {
            delete this.people[id];
            if (this.tiles[id]) {
                this.tiles[id].el.remove();
                delete this.tiles[id];
            }
            this.updateStatus();
        },

        updateStatus: function () {
            var count = this.count(), status = this.status;
            if (this.connection === "live") {
                status.textContent = count === 1
                    ? "only you :: send the address of this page to other people"
                    : count + " here";
            } else if (this.connection === "offline") {
                status.textContent = "offline :: you can add reasons, but other people do not see your typing";
            } else {
                status.textContent = "connecting…";
            }
            if (this.soundBlocked) {
                status.appendChild(document.createTextNode(" "));
                status.appendChild(button("link", "enable sound", "sound"));
            }
        },

        enableSound: function () {
            var _this = this;
            this.soundBlocked = false;
            Object.keys(this.tiles).forEach(function (id) {
                if (id !== "me") {
                    _this.tiles[id].audio.play().catch(function () {});
                }
            });
            this.updateStatus();
        },

        sendState: function () {
            this.room.broadcast("state", {
                name: this.me.name, mic: this.me.mic, cam: this.me.cam
            });
        },

        updateTile: function (id) {
            var me = id === "me",
                person = me ? this.me : this.people[id];
            if (!person) {
                return null;
            }
            var tile = this.tiles[id];
            if (!tile) {
                tile = this.tiles[id] = {el: el("div", "tile")};
                tile.screen = el("div", "tile-screen");
                tile.pre = el("pre", "tile-ascii");
                tile.pre.setAttribute("aria-hidden", "true");
                tile.video = me ? this.localVideo : el("video");
                tile.video.playsInline = true;
                tile.video.autoplay = true;
                tile.video.muted = true;  // sound plays through tile.audio
                tile.audio = el("audio");
                tile.audio.autoplay = true;
                tile.initial = el("div", "tile-initial");
                tile.screen.appendChild(tile.video);
                tile.screen.appendChild(tile.pre);
                tile.screen.appendChild(tile.initial);
                tile.el.appendChild(tile.screen);
                if (!me) {
                    tile.el.appendChild(tile.audio);
                }
                tile.caption = el("div", "tile-caption");
                tile.el.appendChild(tile.caption);
                if (me) {
                    tile.el.classList.add("is-me");
                    this.tilesEl.insertBefore(tile.el, this.tilesEl.firstChild);
                } else {
                    this.tilesEl.appendChild(tile.el);
                }
            }

            var name = person.name || "someone",
                hasVideo = me ? !!this.camTrack : tile.video.srcObject &&
                    tile.video.srcObject.getVideoTracks().some(function (t) {
                        return t.readyState === "live" && !t.muted;
                    }),
                mode = person.cam === "video" && hasVideo
                    ? (this.asciiView ? "ascii-local" : "video")
                    : person.cam === "ascii" ? "ascii" : "off";

            tile.el.setAttribute("data-mode", mode);
            tile.initial.textContent = name.charAt(0).toUpperCase();

            tile.caption.textContent = "";
            tile.caption.appendChild(el("span", "tile-name", me ? name + " (you)" : name));
            tile.caption.appendChild(el("span", "tile-mic" + (person.mic ? " is-on" : ""),
                                        person.mic ? "mic on" : "muted"));
            var writing = this.options.writingLabel(id);
            if (writing) {
                var go = button("tile-writing link", writing, me ? null : "goto");
                go.setAttribute("data-user", id);
                tile.caption.appendChild(go);
            }
            return tile;
        },

        updateControls: function () {
            this.micButton.textContent = this.me.mic ? "mic on" : "mic off";
            this.micButton.setAttribute("aria-pressed", this.me.mic);
            Object.keys(this.camButtons).forEach(function (mode) {
                this.camButtons[mode].setAttribute("aria-pressed", this.me.cam === mode);
            }, this);
        },

        setMic: function (on) {
            var _this = this;
            if (!on) {
                this.stopTrack("audio");
                this.me.mic = false;
                this.afterMediaChange();
                return;
            }
            navigator.mediaDevices.getUserMedia({
                audio: {echoCancellation: true, noiseSuppression: true}
            }).then(function (stream) {
                _this.room.setTrack("audio", stream.getAudioTracks()[0]);
                _this.me.mic = true;
                _this.afterMediaChange();
                _this.enableSound();
            }).catch(function (error) {
                _this.mediaError(error);
            });
        },

        setCam: function (mode) {
            var _this = this;
            if (mode === "off") {
                this.stopTrack("video");
                this.me.cam = "off";
                this.afterMediaChange();
                return;
            }
            var ready = this.camTrack ? Promise.resolve(this.camTrack)
                : navigator.mediaDevices.getUserMedia({
                    video: {width: {ideal: 640}, height: {ideal: 480}}
                }).then(function (stream) {
                    _this.camTrack = stream.getVideoTracks()[0];
                    _this.localVideo.srcObject = new MediaStream([_this.camTrack]);
                    return _this.camTrack;
                });
            ready.then(function (track) {
                _this.me.cam = mode;
                // in ascii mode the camera image stays here; only text frames go out
                _this.room.setTrack("video", mode === "video" ? track : null);
                _this.afterMediaChange();
                _this.enableSound();
            }).catch(function (error) {
                _this.mediaError(error);
            });
        },

        stopTrack: function (kind) {
            var track = kind === "video" ? this.camTrack : this.room.tracks.audio;
            if (track) {
                track.stop();
            }
            if (kind === "video") {
                this.camTrack = null;
                this.localVideo.srcObject = null;
            }
            this.room.setTrack(kind, null);
        },

        afterMediaChange: function () {
            this.mediaNote.classList.remove("is-error");
            this.mediaNote.textContent = NOTE;
            this.updateControls();
            this.updateTile("me");
            this.sendState();
            this.updateAsciiLoop();
        },

        mediaError: function (error) {
            this.controls.hidden = false;
            this.mediaNote.classList.add("is-error");
            this.mediaNote.textContent = error && error.name === "NotAllowedError"
                ? "The browser cannot use the device. Give permission in the browser settings."
                : "No device (" + (error && error.name || error) + "). " +
                  "Camera and microphone need https or localhost.";
            this.updateControls();
        },

        // render ascii for our own camera (sent to the others) and, when
        // "show all video as ascii" is on, for incoming video
        updateAsciiLoop: function () {
            var _this = this,
                needed = this.me.cam === "ascii" || (this.asciiView && Object.keys(this.people)
                    .some(function (id) { return _this.people[id].cam === "video"; }));
            if (needed && !this.asciiTimer) {
                this.asciiTimer = setInterval(this.asciiFrame.bind(this), 1000 / ASCII_FPS);
            } else if (!needed && this.asciiTimer) {
                clearInterval(this.asciiTimer);
                this.asciiTimer = null;
            }
        },

        asciiFrame: function () {
            var _this = this;
            if (document.hidden) {
                return;
            }
            this.frameCount++;
            if (this.me.cam === "ascii" && this.camTrack) {
                var frame = this.renderer.render(this.localVideo);
                if (frame) {
                    this.tiles.me.pre.textContent = frame;
                    this.room.sendFrame("ascii", {f: frame},
                                        this.frameCount % RELAY_EVERY === 0);
                }
            }
            if (this.asciiView) {
                Object.keys(this.tiles).forEach(function (id) {
                    var tile = _this.tiles[id];
                    if (tile.el.getAttribute("data-mode") === "ascii-local") {
                        var local = _this.renderer.render(tile.video);
                        if (local) {
                            tile.pre.textContent = local;
                        }
                    }
                });
            }
        }
    };

    assembly.Presence = Presence;
})(window.arguman = window.arguman || {});
