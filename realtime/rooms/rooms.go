// Package rooms is the chatb.org room relay (https://r-w-x.org/r/chatb.git),
// vendored for KLAP assemblies. The protocol is unchanged: clients receive
// an "init" message with their id, send {"type":"cmd"} messages to join a
// room or set a nick, and every other message is relayed to the room (or to
// a single user when "to" is set). The server never inspects or stores the
// payloads, so drafts, WebRTC signalling and ascii frames all pass through
// the same relay and disappear when the room empties.
//
// Changes from upstream: all room state is guarded by one mutex, the send
// channel is closed exactly once, sends never block the relay, and messages
// from users that have not joined a room are dropped instead of panicking.
package rooms

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"strconv"
	"sync"
	"time"

	"golang.org/x/net/websocket"
)

const (
	MaxMessageBytes = 64 * 1024
	MaxNameLength   = 255
	sendBuffer      = 256
)

type Room struct {
	Name  string           `json:"name"`
	Users map[string]*User `json:"users"`
}

type Message struct {
	Type string `json:"type,omitempty"`
	Data string `json:"data,omitempty"`
	To   string `json:"to,omitempty"`
	From string `json:"from,omitempty"`
}

type Cmd struct {
	Action string `json:"action"`
	Data   string `json:"data,omitempty"`
}

type User struct {
	Id   string          `json:"id"`
	Name string          `json:"name"`
	Room *Room           `json:"-"`
	send chan Message    `json:"-"`
	ws   *websocket.Conn `json:"-"`
	once sync.Once       `json:"-"`
}

var (
	mu    sync.Mutex
	rooms = make(map[string]*Room)
)

// The methods below expect mu to be held by the caller.

func (r *Room) Join(u *User) {
	if u.Room != r {
		if u.Room != nil {
			u.Room.Leave(u)
		}
		u.Room = r
		r.Users[u.Id] = u
		r.SendInfo()
	}
}

func (r *Room) Leave(u *User) {
	u.Room = nil
	delete(r.Users, u.Id)
	if len(r.Users) == 0 {
		delete(rooms, r.Name)
	} else {
		r.SendInfo()
	}
}

func (r *Room) Send(m Message) {
	for _, u := range r.Users {
		u.Send(m)
	}
}

func (r *Room) SendOthers(m Message, sender *User) {
	for _, u := range r.Users {
		if u != sender {
			u.Send(m)
		}
	}
}

func (r *Room) SendPrivateMessage(m Message) {
	if user, ok := r.Users[m.To]; ok {
		user.Send(m)
	}
}

func (r *Room) Info() string {
	var b bytes.Buffer
	s, err := json.Marshal(r)
	if err == nil {
		b.Write(s)
	} else {
		log.Println("failed to marshal room", err)
	}
	return b.String()
}

func (r *Room) SendInfo() {
	r.Send(Message{Type: "info", Data: r.Info()})
}

// Send queues a message without blocking the relay. A client that cannot
// keep up with sendBuffer messages loses the overflow; drafts and frames are
// superseded by the next update anyway.
func (u *User) Send(m Message) {
	if u.send == nil {
		return
	}
	select {
	case u.send <- m:
	default:
		log.Println("dropping message for slow client", u.Id)
	}
}

func (u *User) SendInfo() {
	u.Send(Message{Type: "info", Data: u.Room.Info()})
}

func (u *User) close() {
	u.once.Do(func() {
		mu.Lock()
		if u.Room != nil {
			u.Room.Leave(u)
		}
		close(u.send)
		u.send = nil
		mu.Unlock()
		u.ws.Close()
	})
}

func (u *User) handle(message Message) {
	mu.Lock()
	defer mu.Unlock()

	if message.Type == "cmd" {
		var cmd Cmd
		if err := json.Unmarshal([]byte(message.Data), &cmd); err != nil {
			log.Println("Invalid command", message.Data)
			return
		}
		switch cmd.Action {
		case "leave":
			if u.Room != nil {
				u.Room.Leave(u)
			}
		case "join":
			name := cmd.Data
			if name == "" || len(name) > MaxNameLength {
				return
			}
			room, ok := rooms[name]
			if !ok {
				room = &Room{Name: name, Users: make(map[string]*User)}
				rooms[name] = room
			}
			room.Join(u)
		case "info":
			if u.Room != nil {
				u.SendInfo()
			}
		case "nick":
			if len(cmd.Data) > MaxNameLength {
				return
			}
			u.Name = cmd.Data
			if u.Room != nil {
				u.Room.SendInfo()
			}
		default:
			log.Println("Unknown action", cmd.Action)
		}
		return
	}

	if u.Room == nil {
		return
	}
	message.From = u.Id
	if message.To != "" {
		u.Room.SendPrivateMessage(message)
	} else {
		u.Room.SendOthers(message, u)
	}
}

func (u *User) reader() {
	for {
		var message Message
		if err := websocket.JSON.Receive(u.ws, &message); err != nil {
			if err != io.EOF {
				log.Println("invalid message", err)
			}
			return
		}
		u.handle(message)
	}
}

func (u *User) writer(send chan Message) {
	for m := range send {
		u.ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
		if err := websocket.JSON.Send(u.ws, m); err != nil {
			log.Println("send failed, user disconnected", err)
			go u.close()
			// drain until close() closes the channel
			for range send {
			}
			return
		}
	}
}

func IDChan() <-chan string {
	next := make(chan string)
	id := uint64(time.Now().Unix())
	go func() {
		for {
			next <- strconv.FormatUint(id, 10)
			id++
		}
	}()
	return next
}

var getID = IDChan()

func Handler(ws *websocket.Conn) {
	ws.MaxPayloadBytes = MaxMessageBytes
	send := make(chan Message, sendBuffer)
	u := &User{Id: <-getID, send: send, ws: ws, Room: nil}
	u.Send(Message{Type: "init", Data: u.Id})
	defer u.close()
	go u.writer(send)
	u.reader()
}
