// The live claim map: everyone on a claim page shares the map.
//
// - "add reason" opens a composer as a node of the map, at the branch where
//   the reason will go. Each edit is streamed with its timing (Time Based
//   Text), and the others see the reason typed at that pace in a node at the
//   same place, hesitations and corrections included.
// - Each word of the claim and of the reasons can be questioned ("what do
//   we mean by"); questioned words show a dotted line and a number.
// - Support and fallacy reports work in place, and the map changes for
//   everyone when someone adds, supports or reports.
// - "replay session" types the whole discussion again, reason by reason.
// - With a mouse, a blinking prompt follows the pointer over the map and
//   says what typing will do there; typing starts a reason in that place.
//   The reason types float under the prompt and answer what it is on.
//   The explanations show only while the pointer moves or someone types.
// - Reasons are open text joined by threads (an svg under the map), drawn
//   in the line style of their type, from the parent or from the word that
//   they question.
//
// The map layout is arguman.Tree (main.js); people, voice and video are
// assembly.Presence; the relay is chatb's (room.js). The texts come from
// Django's JavaScript catalog (gettext, ngettext, interpolate: /jsi18n/).

(function (arguman, $) {
    "use strict";

    var assembly = arguman.assembly,
        tbt = assembly.tbt;

    var ROOT = "root",
        STREAM_EVERY = 120,  // ms between two parts of the typing stream
        AIDS_FOR = 2500,     // ms the explanations stay after the last move
        HOVER = window.matchMedia("(hover: hover) and (pointer: fine)").matches,
        SVG = "http://www.w3.org/2000/svg",
        DOUBLE = {but: true, opposition: true},  // drawn as two lines
        ADD_LINK = /\/premises\/(?:(\d+)\/)?new(?:\?|$)/;

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

    function wait(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    function normalize(word) {
        return word.toLowerCase().replace(/[^\wÀ-￿]+/g, "");
    }

    function quote(text) {
        return "“" + text.replace(/^[^\wÀ-￿]+|[^\wÀ-￿]+$/g, "") + "”";
    }

    // Puts each word of container in a .w span, numbered in reading order.
    // Links (the nouns of the claim) and markup stay; the parts listed in
    // `skip` are not words of the text.
    function wrapWords(container, skip) {
        if (!container || container.getAttribute("data-words")) {
            return;
        }
        container.setAttribute("data-words", "1");
        var index = 0,
            walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
                acceptNode: function (node) {
                    return node.parentNode.closest(skip) ? NodeFilter.FILTER_REJECT
                        : NodeFilter.FILTER_ACCEPT;
                }
            }),
            nodes = [];
        while (walker.nextNode()) {
            nodes.push(walker.currentNode);
        }
        nodes.forEach(function (node) {
            var fragment = document.createDocumentFragment();
            node.nodeValue.split(/(\s+)/).forEach(function (token) {
                if (!token) {
                    return;
                }
                if (/^\s+$/.test(token)) {
                    fragment.appendChild(document.createTextNode(token));
                    return;
                }
                var word = el("span", "w", token);
                word.setAttribute("data-i", index++);
                fragment.appendChild(word);
            });
            node.parentNode.replaceChild(fragment, node);
        });
    }

    function wordsOf(container) {
        return container ? Array.prototype.slice.call(container.querySelectorAll(".w")) : [];
    }

    // The word spans an anchor names. The server counts words in the stored
    // text, the page in the rendered one, so the index is checked against
    // the words and the words are looked up when it does not match.
    function locate(words, anchor) {
        var wanted = anchor.text ? anchor.text.split(/\s+/).map(normalize).filter(Boolean) : null,
            span = words.slice(anchor.start, anchor.end + 1);
        if (!wanted || span.map(function (w) { return normalize(w.textContent); })
                .filter(Boolean).join(" ") === wanted.join(" ")) {
            return span;
        }
        var texts = words.map(function (w) { return normalize(w.textContent); });
        for (var i = 0; i + wanted.length <= texts.length; i++) {
            if (texts.slice(i, i + wanted.length).join(" ") === wanted.join(" ")) {
                return words.slice(i, i + wanted.length);
            }
        }
        return [];
    }

    // the reason type of a node of the map ("but", "semantic", …)
    function typeOf(node) {
        var match = /\bt-([a-z]+)/.exec(node.className);
        return node.getAttribute("data-type") || (match ? match[1] : "because");
    }

    // the box around some elements, in page pixels relative to origin
    function boxOf(elements, origin) {
        var box = null;
        elements.forEach(function (element) {
            var r = element.getBoundingClientRect();
            box = box ? {left: Math.min(box.left, r.left), right: Math.max(box.right, r.right),
                         top: Math.min(box.top, r.top), bottom: Math.max(box.bottom, r.bottom)}
                      : {left: r.left, right: r.right, top: r.top, bottom: r.bottom};
        });
        return box && {left: box.left - origin.left, right: box.right - origin.left,
                       top: box.top - origin.top, bottom: box.bottom - origin.top};
    }

    function Live(config, tree, navigator, timeline) {
        this.config = config;
        this.tree = tree;
        this.navigator = navigator;
        this.timeline = timeline;
        this.instruments = {};
        config.instruments.forEach(function (instrument) {
            this.instruments[instrument.type] = instrument;
            if (instrument["class"] === "because") {
                this.defaultType = instrument.type;
            }
        }, this);
        this.drafts = {};
        this.ghosts = {};
        this.composer = null;
        this.name = storage("klap.live.name") || storage("klap.assembly.name") ||
            "guest-" + Math.floor(100 + Math.random() * 900);
    }

    Live.prototype = {
        start: function () {
            var _this = this, strip = document.getElementById("live-strip");
            this.app = document.getElementById("app");
            this.app.classList.toggle("has-pointer", HOVER);

            this.room = new assembly.Room({
                room: this.config.room,
                wsUrl: this.config.wsUrl,
                iceServers: this.config.iceServers,
                nick: this.name
            });
            this.presence = new assembly.Presence(strip, {
                room: this.room,
                name: this.name,
                onName: function (name) {
                    _this.name = name;
                    storage("klap.live.name", name);
                    if (_this.composer) {
                        _this.composer.changed = true;
                    }
                },
                writingLabel: this.writingLabel.bind(this),
                onGoto: this.gotoGhost.bind(this)
            });
            // the map is centred in the space the strip leaves
            this.tree.reservedWidth = function () {
                return getComputedStyle(strip).position === "fixed" &&
                    window.innerWidth > 860 ? strip.offsetWidth : 0;
            };

            // the threads are drawn again after each layout of the map
            this.threads = document.createElementNS(SVG, "svg");
            this.threads.setAttribute("class", "live-threads");
            this.threads.setAttribute("aria-hidden", "true");
            this.app.insertBefore(this.threads, this.app.firstChild);
            var renderTree = this.tree.renderTree;
            this.tree.renderTree = function () {
                var result = renderTree.apply(this, arguments);
                _this.drawThreadsSoon();
                return result;
            };

            this.buildInstruments();
            this.bindEvents();
            this.bindAids();
            this.bindPrompt();
            this.bindRoom();
            this.decorate();
            this.relayout();
            this.room.connect();

            var add = new URLSearchParams(location.search).get("add");
            if (add) {
                history.replaceState(null, "", location.pathname + location.hash);
                this.openComposer(add === ROOT ? ROOT : add, null, null);
            }
        },

        // ----------------------------------------------------------- the map

        wordsEl: function (key) {
            if (key === ROOT) {
                return document.querySelector(".tree-contention h3 > span");
            }
            return document.querySelector("#premise-" + key + " > .tree-node .premise-content");
        },

        // the claim ("root") or the id of the reason an element belongs to
        keyOf: function (element) {
            var branch = element.closest && element.closest("li.tree-branch:not(.live-branch)");
            return branch ? branch.id.replace("premise-", "") : ROOT;
        },

        parentKeyOf: function (branch) {
            var parent = branch.parentNode.closest("li.tree-branch");
            return parent ? parent.id.replace("premise-", "") : ROOT;
        },

        // the list of reasons under key, made when it does not exist yet
        childList: function (key) {
            if (key === ROOT) {
                var root = document.querySelector(".tree-container > ul.tree");
                if (!root) {
                    root = el("ul", "tree");
                    root.setAttribute("data-level", "1");
                    document.querySelector(".tree-container").appendChild(root);
                }
                return root;
            }
            var branch = document.getElementById("premise-" + key);
            if (!branch) {
                return null;
            }
            var list = branch.querySelector(":scope > ul.tree");
            if (!list) {
                var level = Number(branch.parentNode.getAttribute("data-level") || 1);
                list = el("ul", "tree live-made");
                list.setAttribute("data-level", level + 1);
                branch.appendChild(list);
                if (!branch.querySelector(":scope > .child-connector")) {
                    branch.appendChild(el("div", "connector child-connector live-made"));
                }
            }
            if (!list.querySelector(":scope > .tree-connector")) {
                list.appendChild(el("li", "connector tree-connector live-made"));
            }
            return list;
        },

        makeBranch: function (kind) {
            var li = el("li", "tree-branch live-branch " + kind + "-branch"),
                node = el("div", "premise tree-node live-node " + kind);
            li.appendChild(el("div", "connector branch-connector"));
            li.appendChild(node);
            return {li: li, node: node};
        },

        // own composer first, then the drafts of the others, then the reasons
        place: function (li, key) {
            var list = this.childList(key) || this.childList(ROOT);
            if (li.parentNode === list) {
                return;
            }
            this.unplace(li);
            var composer = list.querySelector(":scope > .composer-branch");
            if (li.classList.contains("composer-branch") || !composer) {
                list.insertBefore(li, list.firstChild);
            } else {
                list.insertBefore(li, composer.nextSibling);
            }
            this.relayout();
        },

        unplace: function (li) {
            var list = li.parentNode;
            if (!list) {
                return;
            }
            li.remove();
            if (list.classList.contains("live-made") &&
                    !list.querySelector(":scope > .tree-branch")) {
                var branch = list.parentNode,
                    connector = branch.querySelector(":scope > .child-connector.live-made");
                connector && connector.remove();
                list.remove();
            }
            this.relayout();
        },

        // one layout per frame, whatever asked for it
        relayout: function () {
            if (!this.layoutFrame) {
                this.layoutFrame = requestAnimationFrame(this.layoutNow.bind(this));
            }
        },

        // the layout also shows new nodes (branches start hidden), so it
        // runs at once before something in a new node gets the focus
        layoutNow: function () {
            if (this.layoutFrame) {
                cancelAnimationFrame(this.layoutFrame);
                this.layoutFrame = null;
            }
            var hasBranches = !!document.querySelector(".tree-container li.tree-branch");
            $("#empty-state").toggle(!hasBranches);
            $(".root-connector").toggleClass("empty", !hasBranches);
            this.tree.renderContentionHeader();
            this.tree.renderTree(this.tree.getRoot());
        },

        drawThreadsSoon: function () {
            if (!this.threadFrame) {
                this.threadFrame = requestAnimationFrame(this.drawThreads.bind(this));
            }
        },

        // one thread for each reason, typing box and draft: from the words
        // it questions, or from its parent (the claim: the middle, under the
        // row of the claim), to the left of its type
        drawThreads: function () {
            var _this = this, origin = this.threads.getBoundingClientRect(), paths = [],
                width = 0, height = 0;
            this.threadFrame = null;
            Array.prototype.forEach.call(document.querySelectorAll(".tree-container li.tree-branch"), function (li) {
                var node = li.querySelector(":scope > .tree-node");
                if (!node || !node.getClientRects().length) {
                    return;  // collapsed, or hidden by the replay
                }
                var key = _this.parentKeyOf(li),
                    anchor = _this.anchorOf(li, node),
                    words = anchor ? locate(wordsOf(_this.wordsEl(key)), anchor) : [],
                    from = boxOf(words, origin),
                    x1, y1;
                if (from) {
                    x1 = (from.left + from.right) / 2;
                    y1 = from.bottom + 1;
                } else {
                    var parent = key === ROOT ? _this.instrumentRow
                        : document.querySelector("#premise-" + key + " > .tree-node");
                    from = parent && boxOf([parent], origin);
                    if (!from || from.right === from.left) {
                        return;
                    }
                    x1 = key === ROOT ? (from.left + from.right) / 2 : from.left + 10;
                    y1 = from.bottom + (key === ROOT ? 4 : 0);
                }
                var label = node.querySelector(":scope > .premise-type"),
                    to = boxOf([label || node], origin),
                    x2 = to.left - 6, y2 = to.top + 4,
                    bend = Math.max(18, (y2 - y1) / 2),
                    d = "M" + x1.toFixed(1) + " " + y1.toFixed(1) +
                        " C" + x1.toFixed(1) + " " + (y1 + bend).toFixed(1) +
                        " " + x2.toFixed(1) + " " + (y2 - bend).toFixed(1) +
                        " " + x2.toFixed(1) + " " + y2.toFixed(1),
                    type = typeOf(node),
                    kind = "thread t-" + type + (node.classList.contains("live-node") ? " is-draft" : "");
                width = Math.max(width, x1, x2);
                height = Math.max(height, y1, y2);
                paths.push('<path class="' + kind + '" d="' + d + '"/>');
                if (DOUBLE[type]) {
                    paths.push('<path class="thread-gap' +
                               (kind.indexOf("is-draft") > 0 ? " is-draft" : "") + '" d="' + d + '"/>');
                }
            });
            // as big as the threads: an svg does not draw outside its box
            this.threads.setAttribute("width", Math.ceil(width + 10));
            this.threads.setAttribute("height", Math.ceil(height + 10));
            this.threads.innerHTML = paths.join("");
        },

        // the words a node questions: saved, being typed here, or by someone
        anchorOf: function (li, node) {
            if (this.composer && li === this.composer.li) {
                return this.composer.anchor;
            }
            var from = li.getAttribute("data-user");
            if (from) {
                return this.drafts[from] && this.drafts[from].anchor;
            }
            return node.hasAttribute("data-anchor-start") ? {
                start: Number(node.getAttribute("data-anchor-start")),
                end: Number(node.getAttribute("data-anchor-end")),
                text: node.getAttribute("data-anchor-text")
            } : null;
        },

        // words, anchors and drafts on the html of the map
        decorate: function () {
            var skip = ".premise-anchor, .related-argument, .live-report, .w";
            wrapWords(this.wordsEl(ROOT), skip);
            Array.prototype.forEach.call(
                document.querySelectorAll(".tree-node:not(.live-node) .premise-content"),
                function (content) { wrapWords(content, skip); });
            this.markAnchors();
            this.markDrafting();
        },

        markAnchors: function () {
            var _this = this, counts = new Map();
            Array.prototype.forEach.call(
                document.querySelectorAll(".tree-node[data-anchor-start]:not(.live-node)"),
                function (node) {
                    var branch = node.closest("li.tree-branch"),
                        words = wordsOf(_this.wordsEl(_this.parentKeyOf(branch)));
                    locate(words, {
                        start: Number(node.getAttribute("data-anchor-start")),
                        end: Number(node.getAttribute("data-anchor-end")),
                        text: node.getAttribute("data-anchor-text")
                    }).forEach(function (word) {
                        counts.set(word, (counts.get(word) || 0) + 1);
                    });
                });
            Array.prototype.forEach.call(document.querySelectorAll("#app .w"), function (word) {
                var count = counts.get(word);
                word.classList.toggle("has-anchor", !!count);
                if (count) {
                    word.setAttribute("data-count", count);
                    word.title = interpolate(ngettext("%(count)s reason is about this word",
                                                      "%(count)s reasons are about this word",
                                                      count), {count: count}, true);
                } else {
                    word.removeAttribute("data-count");
                    word.title = gettext("ask what this word means");
                }
            });
        },

        // the words that the composer, or a draft of someone, is about
        markDrafting: function () {
            var _this = this, drafts = [];
            Array.prototype.forEach.call(document.querySelectorAll("#app .w.is-drafting"), function (word) {
                word.classList.remove("is-drafting");
            });
            Object.keys(this.drafts).forEach(function (id) {
                drafts.push({key: _this.drafts[id].node, anchor: _this.drafts[id].anchor});
            });
            if (this.composer) {
                drafts.push({key: this.composer.key, anchor: this.composer.anchor});
            }
            drafts.forEach(function (draft) {
                if (draft.anchor) {
                    locate(wordsOf(_this.wordsEl(draft.key)), draft.anchor).forEach(function (word) {
                        word.classList.add("is-drafting");
                    });
                }
            });
            this.drawThreadsSoon();
        },

        // after a change by anyone: the map from the server, with the
        // drafts still being typed put back in place
        refresh: function () {
            var _this = this;
            if (this.replaying) {
                return Promise.resolve();  // endReplay refreshes
            }
            // one refresh at a time; changes during it get one more
            if (this.refreshing) {
                this.refreshAgain = true;
                return this.refreshing;
            }
            this.refreshing = this.fetchMap().then(function () {
                _this.refreshing = null;
                if (_this.refreshAgain) {
                    _this.refreshAgain = false;
                    return _this.refresh();
                }
            }, function () {
                _this.refreshing = null;
            });
            return this.refreshing;
        },

        fetchMap: function () {
            var _this = this;
            return fetch(this.config.treeUrl, {
                credentials: "same-origin",
                headers: {"X-Requested-With": "XMLHttpRequest"}
            }).then(function (response) {
                return response.text();
            }).then(function (html) {
                var selected = _this.navigator.currentElement && _this.navigator.currentElement.attr("id"),
                    textarea = _this.composer && _this.composer.textarea,
                    focus = textarea && document.activeElement === textarea
                        ? [textarea.selectionStart, textarea.selectionEnd] : null,
                    correcting = _this.editor && document.activeElement === _this.editor.textarea
                        ? [_this.editor.textarea.selectionStart, _this.editor.textarea.selectionEnd] : null;
                // out of the map before jQuery empties it: jQuery would also
                // clear their data (the related claim search of the composer)
                if (_this.composer) {
                    _this.composer.li.remove();
                }
                if (_this.editor) {
                    _this.editor.form.remove();
                }
                Object.keys(_this.ghosts).forEach(function (id) {
                    _this.ghosts[id].li.remove();
                });
                return new Promise(function (resolve) {
                    _this.tree.refresh(html, function () {
                        if (_this.composer) {
                            _this.place(_this.composer.li, _this.composer.key);
                        }
                        Object.keys(_this.ghosts).forEach(_this.placeGhost, _this);
                        _this.showEditor();
                    }, function () {
                        _this.decorate();
                        _this.layoutNow();
                        if (focus && _this.composer) {
                            _this.composer.textarea.focus();
                            _this.composer.textarea.setSelectionRange(focus[0], focus[1]);
                        }
                        if (correcting && _this.editor) {
                            _this.editor.textarea.focus();
                            _this.editor.textarea.setSelectionRange(correcting[0], correcting[1]);
                        }
                        if (selected && document.getElementById(selected)) {
                            _this.navigator.select($("#" + selected));
                        }
                        _this.timeline.render();
                        _this.relayout();
                        resolve();
                    });
                });
            });
        },

        refreshSoon: function () {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = setTimeout(this.refresh.bind(this), 200);
        },

        // tell the others that the map changed, then show it here
        changed: function (id) {
            this.room.broadcast("changed", {id: id || null});
            return this.refresh();
        },

        // ------------------------------------------------------ the claim

        buildInstruments: function () {
            var row = this.instrumentRow = el("div", "live-instruments"),
                chips = el("div", "instruments");
            this.config.instruments.forEach(function (instrument) {
                if (instrument.type === this.config.semanticType) {
                    return;  // reached by clicking a word
                }
                var b = button("instrument t-" + instrument["class"],
                               instrument.label + " …", "instrument");
                b.setAttribute("data-type", instrument.type);
                b.title = instrument.help;
                chips.appendChild(b);
            }, this);
            // with a mouse the types float under the prompt (bindPrompt)
            var float = this.float = el("div", "live-float" + (HOVER ? " is-floating" : ""));
            float.appendChild(chips);
            float.appendChild(el("p", "live-hint live-aid",
                HOVER ? gettext("answer with :: everyone here sees you type")
                      : gettext("choose how your reason answers the claim :: everyone here sees you type")));
            row.appendChild(float);
            var replay = el("div", "live-replay");
            this.replayButton = button("link", "▶ " + gettext("replay session"), "replay");
            replay.appendChild(this.replayButton);
            this.speed = el("select", "replay-speed");
            this.speed.setAttribute("aria-label", gettext("replay speed"));
            [1, 4, 16].forEach(function (speed) {
                var option = el("option", null, speed + "×");
                option.value = speed;
                this.speed.appendChild(option);
            }, this);
            this.speed.value = "4";
            replay.appendChild(this.speed);
            row.appendChild(replay);
            var claim = document.querySelector(".tree-contention");
            claim.parentNode.insertBefore(row, claim.nextSibling);
            claim.insertBefore(el("p", "live-aid aid-above",
                                  "// " + gettext("click a word to ask what it means")), claim.firstChild);
        },

        // ---------------------------------------------------------- events

        bindEvents: function () {
            var _this = this, app = document.getElementById("app");

            document.addEventListener("click", function (event) {
                var target = event.target;
                if (!app.contains(target)) {
                    return;
                }

                var word = target.closest(".w");
                if (word && !target.closest(".live-node")) {
                    event.preventDefault();  // words inside the noun links too
                    _this.pickWord(_this.keyOf(word), Number(word.getAttribute("data-i")),
                                   event.shiftKey);
                    return;
                }

                var link = target.closest("a[href]");
                var match = link && ADD_LINK.exec(link.getAttribute("href"));
                if (match) {
                    event.preventDefault();
                    _this.openComposer(match[1] || ROOT, null, null);
                    return;
                }
                if (link && link.closest(".report")) {
                    event.preventDefault();
                    _this.openReport(_this.keyOf(link));
                    return;
                }
                if (link && link.classList.contains("edit-premise")) {
                    event.preventDefault();
                    _this.openEditor(_this.keyOf(link), link.getAttribute("data-text") || "");
                    return;
                }

                var action = target.closest("[data-action]");
                if (!action) {
                    return;
                }
                switch (action.getAttribute("data-action")) {
                case "instrument":
                    _this.openComposer(_this.floatKey || ROOT, null, Number(action.getAttribute("data-type")));
                    _this.leaveFloat();
                    break;
                case "set-type":
                    _this.setType(Number(action.getAttribute("data-type")));
                    break;
                case "clear-anchor":
                    _this.composer.anchor = null;
                    _this.composer.changed = true;
                    _this.updateComposer();
                    break;
                case "sources":
                case "related":
                    _this.toggleExtra(action.getAttribute("data-action"));
                    break;
                case "submit":
                    _this.submit();
                    break;
                case "cancel":
                    _this.closeComposer();
                    break;
                case "report-cancel":
                    _this.closeReport(action.closest(".live-report"));
                    break;
                case "edit-save":
                    _this.saveEditor();
                    break;
                case "edit-cancel":
                    _this.closeEditor();
                    break;
                case "replay":
                    _this.replay();
                    break;
                }
            });

            // support and undo, in place
            $(app).on("submit", "form.support", function (event) {
                event.preventDefault();
                var form = this;
                fetch(form.action, {
                    method: "POST",
                    credentials: "same-origin",
                    headers: {"X-Requested-With": "XMLHttpRequest"},
                    body: new FormData(form)
                }).then(function (response) {
                    if (response.ok) {
                        _this.changed(_this.keyOf(form));
                    }
                });
            });

            $(app).on("submit", "form.live-report", function (event) {
                event.preventDefault();
                _this.sendReport(this);
            });
        },

        // ---------------------------------------- explanations and prompt

        // the explanations (.live-aid) show while the pointer moves and
        // while someone types; with no mouse they always show
        bindAids: function () {
            var app = this.app = document.getElementById("app"), timer = null, last = 0;
            if (!HOVER) {
                app.classList.add("aids-on");
                return;
            }
            var wake = function () {
                var now = Date.now();
                if (now - last < 200) {
                    return;
                }
                last = now;
                app.classList.add("aids-on");
                clearTimeout(timer);
                timer = setTimeout(function () {
                    app.classList.remove("aids-on");
                }, AIDS_FOR);
            };
            document.addEventListener("pointermove", wake, {passive: true});
            document.addEventListener("wheel", wake, {passive: true});
            app.addEventListener("focusin", wake);
        },

        // the explanations of the composer, while typing
        wakeTyping: function () {
            var app = this.app;
            if (!app || !HOVER) {
                return;
            }
            app.classList.add("typing-on");
            clearTimeout(this.typingTimer);
            this.typingTimer = setTimeout(function () {
                app.classList.remove("typing-on");
            }, AIDS_FOR);
        },

        // a blinking caret follows the pointer over the map; over the claim
        // or a reason it becomes a prompt, and typing starts a reason there
        bindPrompt: function () {
            var _this = this, app = this.app, x = 0, y = 0, target = null, frame = null;

            document.addEventListener("keydown", this.typeToStart.bind(this));
            if (!HOVER) {
                return;
            }
            var prompt = this.prompt = el("div", "live-prompt"),
                text = el("span", "prompt-text");
            prompt.setAttribute("aria-hidden", "true");
            prompt.hidden = true;
            prompt.appendChild(text);
            prompt.appendChild(el("span", "tbt-caret"));
            document.body.appendChild(prompt);

            // the reason types glide after the prompt, faint and out of the
            // way; when the pointer rests they settle, and then wait for it
            // while it stays on the same node
            var float = this.float, fx = 0, fy = 0, tx = 0, ty = 0, glide = null, settle = null;
            var step = function () {
                fx += (tx - fx) * 0.2;
                fy += (ty - fy) * 0.2;
                if (Math.abs(tx - fx) < 0.5 && Math.abs(ty - fy) < 0.5) {
                    fx = tx;
                    fy = ty;
                    glide = null;
                } else {
                    glide = requestAnimationFrame(step);
                }
                float.style.transform = "translate(" + Math.round(fx) + "px, " + Math.round(fy) + "px)";
            };
            var follow = function (key) {
                var r = float.getBoundingClientRect(),
                    on = float.classList.contains("is-on"),
                    away = Math.max(r.left - x, 0, x - r.right) + Math.max(r.top - y, 0, y - r.bottom);
                if (float.classList.contains("is-settled") && key === _this.floatKey && away < 160) {
                    return;
                }
                _this.floatKey = key;
                float.classList.remove("is-settled");
                clearTimeout(settle);
                settle = setTimeout(function () {
                    if (float.classList.contains("is-on")) {
                        float.classList.add("is-settled");
                    }
                }, 350);
                tx = Math.max(8, Math.min(x + 14, window.innerWidth - r.width - 8));
                ty = y + 44;
                if (!on) {
                    fx = tx;
                    fy = ty;
                    float.classList.add("is-on");
                }
                if (!glide) {
                    glide = requestAnimationFrame(step);
                }
            };
            this.leaveFloat = function () {
                clearTimeout(settle);
                float.classList.remove("is-on", "is-settled");
                _this.markAnswered(null);
            };
            // with the keyboard: under the claim
            float.addEventListener("focusin", function () {
                if (!float.classList.contains("is-on")) {
                    var home = _this.instrumentRow.getBoundingClientRect();
                    tx = fx = home.left + (home.width - float.offsetWidth) / 2;
                    ty = fy = home.top;
                    _this.floatKey = ROOT;
                    float.classList.add("is-on", "is-settled");
                    step();
                }
            });
            float.addEventListener("mouseenter", function () {
                _this.markAnswered(_this.floatKey);
            });
            float.addEventListener("mouseleave", function () {
                _this.markAnswered(null);
            });

            var update = function () {
                frame = null;
                var word = target && target.closest(".w"),
                    composer = _this.composer,
                    typing = composer && composer.node.contains(document.activeElement);
                _this.hoverKey = _this.hoverWord = null;
                if (!target || !app.contains(target) || typing || _this.replaying) {
                    prompt.hidden = true;
                    if (!(target && float.contains(target))) {
                        _this.leaveFloat();
                    }
                    return;
                }
                if ((!word && target.closest("a, button, input, textarea, select, label")) ||
                        target.closest(".live-node, .live-report, .tree-contention-actions, .live-float")) {
                    prompt.hidden = true;
                    return;
                }
                var node = target.closest(".tree-node, .tree-contention h3");
                if (node) {
                    follow(_this.keyOf(node));
                }
                if (word) {
                    _this.hoverWord = word;
                    text.textContent = interpolate(gettext("what do we mean by %(word)s?"),
                                                   {word: quote(word.textContent)}, true);
                } else if (node) {
                    _this.hoverKey = _this.keyOf(node);
                    text.textContent = gettext("type to answer");
                } else {
                    text.textContent = "";
                }
                prompt.classList.toggle("is-caret", !text.textContent);
                prompt.hidden = false;
                // to the left of the pointer near the right edge
                var left = x + 14;
                if (left + prompt.offsetWidth > window.innerWidth - 8) {
                    left = x - 10 - prompt.offsetWidth;
                }
                prompt.style.transform = "translate(" + left + "px, " + (y + 18) + "px)";
            };
            var schedule = function () {
                if (!frame) {
                    frame = requestAnimationFrame(update);
                }
            };

            document.addEventListener("pointermove", function (event) {
                x = event.clientX;
                y = event.clientY;
                // no prompt while dragging the map
                target = event.buttons ? null : event.target;
                schedule();
            }, {passive: true});
            // the page moves under a still pointer
            window.addEventListener("scroll", function () {
                target = document.elementFromPoint(x, y);
                schedule();
            }, {passive: true});
            document.documentElement.addEventListener("mouseleave", function () {
                target = null;
                schedule();
            });
            document.addEventListener("focusin", schedule);
        },

        // bindPrompt replaces it when the types float
        leaveFloat: function () {},

        // the node that the floating types will answer
        markAnswered: function (key) {
            var current = document.querySelector("#app .is-answered"),
                next = key ? this.wordsEl(key) : null;
            if (current && current !== next) {
                current.classList.remove("is-answered");
            }
            if (next) {
                next.classList.add("is-answered");
            }
        },

        // a letter typed on the map starts a reason: where the prompt is,
        // else on the reason selected with the arrows, else on the claim
        typeToStart: function (event) {
            var active = document.activeElement;
            if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey ||
                    event.isComposing || event.key.length !== 1 || event.key === " " ||
                    this.replaying ||
                    (active && active.closest("input, textarea, select, [contenteditable]"))) {
                return;
            }
            event.preventDefault();
            var word = this.hoverWord, selected = this.navigator.currentElement;
            if (this.composer) {
                this.openComposer(this.composer.key, null, null);
            } else if (word) {
                this.pickWord(this.keyOf(word), Number(word.getAttribute("data-i")), false);
            } else {
                this.openComposer(this.hoverKey ||
                                  (selected && selected.length ? this.keyOf(selected[0]) : ROOT),
                                  null, null);
            }
            var textarea = this.composer && this.composer.textarea;
            if (textarea && document.activeElement === textarea) {
                textarea.setRangeText(event.key, textarea.selectionStart, textarea.selectionEnd, "end");
                textarea.dispatchEvent(new Event("input"));
            }
            if (this.prompt) {
                this.prompt.hidden = true;
                this.leaveFloat();
            }
        },

        bindRoom: function () {
            var _this = this, room = this.room;
            room.on("draft", this.receiveDraft.bind(this));
            room.on("changed", this.refreshSoon.bind(this));
            room.on("left", this.removeGhost.bind(this));
            room.on("users", function (users, joined) {
                Object.keys(_this.ghosts).forEach(function (id) {
                    if (!users[id]) {
                        _this.removeGhost(id);
                    }
                });
                if (joined.length) {
                    // newcomers see what everyone is in the middle of writing
                    _this.sendDraft(true);
                }
            });
        },

        writingLabel: function (id) {
            var draft = id === "me" ? this.composer : this.drafts[id],
                instrument = draft && this.instruments[draft.type];
            return draft ? gettext("writes") + (instrument ? " :: " + instrument.label : "") + "…" : null;
        },

        // -------------------------------------------------------- composer

        pickWord: function (key, index, extend) {
            var composer = this.composer, anchor = {start: index, end: index};
            if (composer && composer.key === key && composer.anchor && extend) {
                anchor = {
                    start: Math.min(composer.anchor.start, index),
                    end: Math.max(composer.anchor.end, index)
                };
            }
            var type = composer && composer.key === key ? composer.type : this.config.semanticType;
            this.openComposer(key, anchor, type);
        },

        openComposer: function (key, anchor, type) {
            if (!this.wordsEl(key)) {
                return;
            }
            var composer = this.composer || (this.composer = this.buildComposer());
            if (composer.key !== key) {
                composer.anchor = null;
            }
            composer.key = key;
            if (anchor) {
                composer.anchor = anchor;
            }
            if (type !== null && type !== undefined) {
                composer.type = type;
            } else if (composer.type === null) {
                composer.type = this.defaultType;
            }
            composer.changed = true;
            this.leaveFloat();
            this.place(composer.li, key);
            this.updateComposer();
            this.layoutNow();
            composer.textarea.focus({preventScroll: true});
            composer.node.scrollIntoView({block: "nearest", inline: "nearest", behavior: "smooth"});
            this.wakeTyping();
            this.sendDraft();
        },

        buildComposer: function () {
            var _this = this,
                branch = this.makeBranch("composer"),
                composer = {li: branch.li, node: branch.node, key: null, type: null,
                            anchor: null, related: null, seq: 0,
                            recorder: new tbt.Recorder()},
                node = branch.node,
                types = el("div", "composer-types");

            this.config.instruments.forEach(function (instrument) {
                var b = button("instrument t-" + instrument["class"], instrument.label, "set-type");
                b.setAttribute("data-type", instrument.type);
                types.appendChild(b);
            });
            node.appendChild(types);
            composer.help = el("div", "composer-help live-aid");
            node.appendChild(composer.help);
            composer.anchorEl = el("div", "composer-anchor");
            node.appendChild(composer.anchorEl);

            var textarea = composer.textarea = el("textarea", "composer-text");
            textarea.rows = 3;
            textarea.maxLength = this.config.maxLength;
            textarea.setAttribute("aria-label", gettext("reason"));
            node.appendChild(textarea);

            var extras = el("div", "composer-extras");
            extras.appendChild(button("link", "+ " + gettext("sources"), "sources"));
            extras.appendChild(button("link", "+ " + gettext("related claim"), "related"));
            node.appendChild(extras);
            composer.sources = el("textarea", "composer-sources");
            composer.sources.rows = 2;
            composer.sources.placeholder = gettext("sources: links, books, people");
            composer.sources.hidden = true;
            node.appendChild(composer.sources);
            composer.relatedInput = el("input", "composer-related");
            composer.relatedInput.type = "text";
            composer.relatedInput.placeholder = gettext("search a claim");
            composer.relatedInput.hidden = true;
            node.appendChild(composer.relatedInput);
            $(composer.relatedInput).autocomplete({
                source: function (search, callback) {
                    $.getJSON(_this.config.searchUrl, {keywords: search.term, json: true}, callback);
                },
                select: function (event, ui) {
                    composer.related = ui.item.id;
                    composer.relatedInput.value = ui.item.label;
                    return false;
                }
            });
            composer.relatedInput.addEventListener("input", function () {
                composer.related = null;
            });

            var foot = el("div", "composer-foot");
            foot.appendChild(el("span", "composer-keys live-aid", gettext("Enter adds :: Escape closes")));
            composer.counter = el("span", "composer-counter");
            foot.appendChild(composer.counter);
            foot.appendChild(button("link", gettext("cancel"), "cancel"));
            composer.submitButton = button("composer-submit", gettext("add reason"), "submit");
            foot.appendChild(composer.submitButton);
            node.appendChild(foot);
            composer.error = el("div", "composer-error");
            node.appendChild(composer.error);

            textarea.addEventListener("input", function () {
                // one line per reason: it keeps the recording a typewriter line
                var value = textarea.value.replace(/\s*\n\s*/g, " ");
                if (value !== textarea.value) {
                    var caret = textarea.selectionStart;
                    textarea.value = value;
                    textarea.selectionStart = textarea.selectionEnd = Math.min(caret, value.length);
                }
                composer.recorder.update(value);
                composer.error.textContent = "";
                _this.wakeTyping();
                _this.updateCounter();
            });
            textarea.addEventListener("keydown", function (event) {
                if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                    event.preventDefault();
                    _this.submit();
                } else if (event.key === "Escape") {
                    _this.closeComposer();
                }
            });

            // the typing goes out in small parts, each edit with its timing
            composer.timer = setInterval(function () {
                _this.sendDraft();
            }, STREAM_EVERY);
            return composer;
        },

        setType: function (type) {
            this.composer.type = type;
            this.composer.changed = true;
            this.updateComposer();
            this.composer.textarea.focus();
        },

        toggleExtra: function (which) {
            var field = which === "sources" ? this.composer.sources : this.composer.relatedInput;
            field.hidden = !field.hidden;
            this.layoutNow();
            if (!field.hidden) {
                field.focus();
            }
        },

        updateComposer: function () {
            var composer = this.composer,
                instrument = this.instruments[composer.type],
                semantic = composer.type === this.config.semanticType;

            composer.node.className = "premise tree-node live-node composer t-" + instrument["class"];
            composer.help.textContent = instrument.label + " :: " + instrument.help;
            Array.prototype.forEach.call(composer.node.querySelectorAll(".composer-types .instrument"), function (b) {
                b.setAttribute("aria-pressed", Number(b.getAttribute("data-type")) === composer.type);
            });

            composer.anchorEl.textContent = "";
            if (composer.anchor) {
                var words = wordsOf(this.wordsEl(composer.key))
                    .slice(composer.anchor.start, composer.anchor.end + 1)
                    .map(function (word) { return word.textContent; }).join(" ");
                composer.anchor.text = words;
                composer.anchorEl.appendChild(document.createTextNode(gettext("on") + " "));
                composer.anchorEl.appendChild(el("strong", null, quote(words)));
                composer.anchorEl.appendChild(document.createTextNode(" "));
                composer.anchorEl.appendChild(button("link", "×", "clear-anchor"));
            } else if (semantic) {
                composer.anchorEl.textContent = gettext("Click the word that you want to question.");
            }

            composer.textarea.placeholder = semantic
                ? (composer.anchor ? interpolate(gettext("by %(word)s we could mean …"),
                                                 {word: quote(composer.anchor.text)}, true)
                                   : gettext("click a word first"))
                : instrument.label + " …";
            this.updateCounter();
            this.markDrafting();
            this.presence.updateTile("me");
            this.relayout();
        },

        updateCounter: function () {
            var composer = this.composer,
                length = composer.textarea.value.trim().length,
                blocked = composer.type === this.config.semanticType && !composer.anchor;
            composer.counter.textContent = length + "/" + this.config.maxLength;
            composer.submitButton.disabled = !length || blocked;
        },

        closeComposer: function () {
            var composer = this.composer;
            if (!composer) {
                return;
            }
            clearInterval(composer.timer);
            $(composer.relatedInput).autocomplete("destroy");
            this.unplace(composer.li);
            this.composer = null;
            this.markDrafting();
            this.room.broadcast("draft", null);
            this.presence.updateTile("me");
        },

        submit: function () {
            var _this = this, composer = this.composer;
            if (!composer || composer.submitButton.disabled || composer.sending) {
                return;
            }
            composer.sending = true;
            composer.submitButton.textContent = gettext("adding…");
            fetch(this.config.branchUrl, {
                method: "POST",
                credentials: "same-origin",
                headers: {
                    "Content-Type": "application/json",
                    "X-CSRFToken": this.config.csrfToken
                },
                body: JSON.stringify({
                    parent: composer.key === ROOT ? null : Number(composer.key),
                    premise_type: composer.type,
                    text: composer.textarea.value.trim(),
                    anchor: composer.anchor,
                    tbt: composer.recorder.recording(),
                    sources: composer.sources.value,
                    related_argument: composer.related,
                    name: this.name
                })
            }).then(function (response) {
                return response.json().then(function (body) {
                    if (!response.ok) {
                        throw new Error(body.error || gettext("The reason was not added."));
                    }
                    return body;
                });
            }).then(function (premise) {
                _this.closeComposer();
                return _this.changed(premise.id).then(function () {
                    var added = $("#premise-" + premise.id);
                    if (added.length) {
                        added.find("> .tree-node").addClass("is-new");
                        _this.navigator.select(added, true);
                    }
                });
            }).catch(function (error) {
                if (_this.composer === composer) {
                    composer.error.textContent = error.message;
                }
            }).then(function () {
                composer.sending = false;
                composer.submitButton.textContent = gettext("add reason");
            });
        },

        // the next part of the typing stream; `full` also when nothing
        // changed, for people who just came in
        sendDraft: function (full) {
            var composer = this.composer;
            if (!composer) {
                return;
            }
            var entries = composer.recorder.drain(),
                caret = composer.textarea.selectionEnd;
            if (!entries.length && !composer.changed && caret === composer.caret && !full) {
                return;
            }
            composer.changed = false;
            composer.caret = caret;
            this.room.broadcast("draft", {
                seq: ++composer.seq,
                name: this.name,
                node: composer.key,
                type: composer.type,
                anchor: composer.anchor,
                entries: entries,
                text: composer.textarea.value,
                caret: caret
            });
            this.presence.updateTile("me");
        },

        // ---------------------------------------------- drafts of the others

        receiveDraft: function (from, draft) {
            if (!draft || typeof draft.text !== "string") {
                this.removeGhost(from);
                return;
            }
            var previous = this.drafts[from],
                continuous = previous && draft.seq === previous.seq + 1;
            this.drafts[from] = {
                seq: draft.seq,
                name: draft.name,
                node: this.wordsEl(String(draft.node)) ? String(draft.node) : ROOT,
                type: draft.type,
                anchor: draft.anchor,
                text: draft.text.slice(0, this.config.maxLength)
            };
            var ghost = this.ghosts[from] || this.makeGhost(from);
            this.placeGhost(from);
            var instrument = this.instruments[draft.type] || {label: "", "class": ""},
                name = this.presence.name(from) || draft.name || gettext("someone");
            ghost.node.className = "premise tree-node live-node ghost t-" + instrument["class"];
            ghost.who.textContent = interpolate(gettext("%(name)s writes"), {name: name}, true) +
                " :: " + instrument.label +
                (draft.anchor && draft.anchor.text ? " " + quote(draft.anchor.text) : "");
            if (continuous) {
                ghost.stream.push(draft.entries, this.drafts[from].text);
            } else {
                ghost.stream.reset(this.drafts[from].text, draft.caret);
            }
            this.markDrafting();
            this.presence.updateTile(from);
        },

        makeGhost: function (from) {
            var _this = this, branch = this.makeBranch("ghost"),
                ghost = {li: branch.li, node: branch.node};
            ghost.li.setAttribute("data-user", from);
            ghost.who = el("div", "ghost-who");
            ghost.text = el("p", "ghost-text");
            ghost.node.appendChild(ghost.who);
            ghost.node.appendChild(ghost.text);
            ghost.stream = new tbt.Stream(function (text, caret) {
                var height = ghost.node.offsetHeight;
                ghost.text.textContent = "";
                ghost.text.appendChild(document.createTextNode(text.slice(0, caret)));
                ghost.text.appendChild(el("span", "tbt-caret"));
                ghost.text.appendChild(document.createTextNode(text.slice(caret)));
                if (ghost.node.offsetHeight !== height) {
                    _this.tree.setAppHeight();
                }
            });
            this.ghosts[from] = ghost;
            return ghost;
        },

        placeGhost: function (from) {
            var ghost = this.ghosts[from], draft = this.drafts[from];
            if (ghost && draft) {
                this.place(ghost.li, draft.node);
            }
        },

        removeGhost: function (from) {
            var ghost = this.ghosts[from];
            delete this.drafts[from];
            if (ghost) {
                ghost.stream.stop();
                this.unplace(ghost.li);
                delete this.ghosts[from];
            }
            this.markDrafting();
            this.presence.updateTile(from);
        },

        gotoGhost: function (from) {
            var ghost = this.ghosts[from];
            if (ghost) {
                ghost.node.scrollIntoView({block: "center", inline: "center", behavior: "smooth"});
                ghost.node.classList.remove("is-flash");
                void ghost.node.offsetWidth;
                ghost.node.classList.add("is-flash");
            }
        },

        // ---------------------------------------------------- fallacies

        openReport: function (key) {
            var node = document.querySelector("#premise-" + key + " > .tree-node");
            if (!node || node.querySelector(".live-report")) {
                return;
            }
            var form = el("form", "live-report"),
                select = el("select"),
                reason = el("textarea");
            form.appendChild(el("strong", null, gettext("report fallacy")));
            select.name = "fallacy_type";
            select.setAttribute("aria-label", gettext("fallacy"));
            this.config.fallacies.forEach(function (fallacy) {
                var option = el("option", null, fallacy.label);
                option.value = fallacy.type;
                select.appendChild(option);
            });
            form.appendChild(select);
            reason.name = "reason";
            reason.rows = 3;
            reason.required = true;
            reason.placeholder = gettext("Why is this a fallacy?");
            form.appendChild(reason);
            var foot = el("div", "composer-foot");
            foot.appendChild(button("link", gettext("cancel"), "report-cancel"));
            var send = el("button", "composer-submit", gettext("report"));
            send.type = "submit";
            foot.appendChild(send);
            form.appendChild(foot);
            form.appendChild(el("div", "composer-error"));
            form.setAttribute("data-key", key);
            node.appendChild(form);
            this.layoutNow();
            select.focus();
        },

        closeReport: function (form) {
            form.remove();
            this.relayout();
        },

        sendReport: function (form) {
            var _this = this, data = new FormData(form),
                key = form.getAttribute("data-key");
            data.append("csrfmiddlewaretoken", this.config.csrfToken);
            fetch(this.config.reportUrl.replace("{id}", key), {
                method: "POST",
                credentials: "same-origin",
                headers: {"X-Requested-With": "XMLHttpRequest"},
                body: data
            }).then(function (response) {
                return response.json().then(function (body) {
                    if (!response.ok) {
                        var errors = body.errors || {};
                        throw new Error(Object.keys(errors).map(function (field) {
                            return errors[field].join(" ");
                        }).join(" ") || gettext("The report was not sent."));
                    }
                    _this.changed(key);
                });
            }).catch(function (error) {
                form.querySelector(".composer-error").textContent = error.message;
                _this.relayout();
            });
        },

        // ---------------------------------------------------- corrections

        // "edit" on an own reason: its text in a box in its place, to
        // correct a typo. Enter saves, Escape closes. The correction is
        // recorded, so a replay types it too.
        openEditor: function (key, text) {
            var _this = this;
            if (this.replaying || !document.querySelector("#premise-" + key + " > .tree-node")) {
                return;
            }
            if (this.editor) {
                if (this.editor.key === key) {
                    this.editor.textarea.focus();
                    return;
                }
                this.closeEditor();
            }
            var editor = this.editor = {key: key, form: el("div", "live-edit"),
                                        recorder: new tbt.Recorder()},
                textarea = editor.textarea = el("textarea");
            editor.recorder.reset(text);
            textarea.value = text;
            textarea.rows = 3;
            textarea.maxLength = this.config.maxLength;
            textarea.setAttribute("aria-label", gettext("correct the reason"));
            editor.form.appendChild(textarea);
            var foot = el("div", "composer-foot");
            foot.appendChild(el("span", "composer-keys live-aid", gettext("Enter saves :: Escape closes")));
            foot.appendChild(button("link", gettext("cancel"), "edit-cancel"));
            editor.saveButton = button("composer-submit", gettext("save"), "edit-save");
            foot.appendChild(editor.saveButton);
            editor.form.appendChild(foot);
            editor.error = el("div", "composer-error");
            editor.form.appendChild(editor.error);

            textarea.addEventListener("input", function () {
                editor.recorder.update(textarea.value);
                editor.error.textContent = "";
            });
            textarea.addEventListener("keydown", function (event) {
                if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                    event.preventDefault();
                    _this.saveEditor();
                } else if (event.key === "Escape") {
                    _this.closeEditor();
                }
            });

            this.showEditor();
            this.layoutNow();
            textarea.focus({preventScroll: true});
            textarea.setSelectionRange(text.length, text.length);
        },

        // the box in place of the text of its reason (again after a refresh)
        showEditor: function () {
            var editor = this.editor,
                node = editor && document.querySelector("#premise-" + editor.key + " > .tree-node");
            if (!node) {
                this.editor = null;  // the reason was removed
                return;
            }
            var content = node.querySelector(".premise-content");
            content.hidden = true;
            node.insertBefore(editor.form, content.nextSibling);
        },

        closeEditor: function () {
            var editor = this.editor,
                node = editor && editor.form.parentNode;
            if (!editor) {
                return;
            }
            this.editor = null;
            if (node) {
                node.querySelector(".premise-content").hidden = false;
                editor.form.remove();
            }
            this.relayout();
        },

        saveEditor: function () {
            var _this = this, editor = this.editor;
            if (!editor || editor.sending) {
                return;
            }
            editor.sending = true;
            editor.saveButton.textContent = gettext("saving…");
            fetch(this.config.textUrl.replace("{id}", editor.key), {
                method: "POST",
                credentials: "same-origin",
                headers: {
                    "Content-Type": "application/json",
                    "X-CSRFToken": this.config.csrfToken
                },
                body: JSON.stringify({
                    text: editor.textarea.value.trim(),
                    tbt: editor.recorder.recording()
                })
            }).then(function (response) {
                return response.json().catch(function () {
                    return {};
                }).then(function (body) {
                    if (!response.ok) {
                        throw new Error(body.error || gettext("The correction was not saved."));
                    }
                });
            }).then(function () {
                _this.closeEditor();
                return _this.changed(editor.key);
            }).catch(function (error) {
                if (_this.editor === editor) {
                    editor.error.textContent = error.message;
                    _this.relayout();
                }
            }).then(function () {
                editor.sending = false;
                editor.saveButton.textContent = gettext("save");
            });
        },

        // ------------------------------------------------- session replay

        // the reasons typed again in the order and at the pace they were
        // added, with long pauses shortened
        replay: function () {
            var _this = this;
            if (this.replaying) {
                this.stopReplay();
                return;
            }
            this.closeEditor();
            var run = this.run = (this.run || 0) + 1;
            this.replaying = true;
            this.replayButton.textContent = "■ " + gettext("stop");
            this.stopPlay = null;
            fetch(this.config.dataUrl + "?tbt=1", {credentials: "same-origin"})
                .then(function (response) { return response.json(); })
                .then(function (data) {
                    $(".tree-container li.tree-branch:not(.live-branch)").addClass("is-hidden");
                    _this.relayout();
                    return data.premises.reduce(function (previous, premise) {
                        return previous.then(function () {
                            return _this.replayOne(premise);
                        });
                    }, wait(400));
                })
                .catch(function () {})
                .then(function () {
                    _this.endReplay(run);
                });
        },

        replayOne: function (premise) {
            var _this = this, speed = Number(this.speed.value);
            if (!this.replaying) {
                return Promise.resolve();
            }
            var branch = $("#premise-" + premise.id);
            if (!branch.length) {
                return Promise.resolve();
            }
            branch.removeClass("is-hidden collapsed").parents("li.tree-branch")
                .removeClass("is-hidden collapsed");
            var content = branch.find("> .tree-node .premise-content")[0];
            content.textContent = "";
            this.tree.renderTree(this.tree.getRoot());
            this.navigator.select(branch, true);
            return new Promise(function (resolve) {
                if (premise.tbt && premise.tbt.length) {
                    _this.stopPlay = tbt.play(premise.tbt, content, {
                        speed: speed, maxPause: 1500, onEnd: resolve
                    });
                } else {
                    content.textContent = premise.text;
                    resolve();
                }
            }).then(function () {
                return wait(700 / speed);
            });
        },

        // a stopped playback never ends by itself, so stopping ends the run
        stopReplay: function () {
            this.stopPlay && this.stopPlay();
            this.endReplay(this.run);
        },

        endReplay: function (run) {
            if (run !== this.run || this.run === this.ended) {
                return;
            }
            this.ended = run;
            this.replaying = false;
            this.replayButton.textContent = "▶ " + gettext("replay session");
            this.refresh();
        }
    };

    assembly.Live = Live;
})(window.arguman = window.arguman || {}, jQuery);
