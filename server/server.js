const WebSocket = require("ws");

// A room, which holds participants.
class Channel {
    constructor() {
        this.participants = new Set();
        // It'd be better if we could just keep track of the overall canvas, but that requires
        // a Node.js library for doing canvas operations. For now, we're just going to record every
        // action that's made and sent it to all participants. If it doesn't scale well, we'll
        // approach it differently.
        this.canvas = [];
    }

    // Determine whether the participant is permitted to join or not.
    admit(ws) {
        if (this.participants.has(ws)) {
            // They've already joined!
            return false;
        } else {
            // All channels are public right now! They can join.
            this.participants.add(ws);
            ws.send(JSON.stringify({
                kind: "channel",
                canvas: this.canvas,
            }));
            return true;
        }
    }

    draw(data) {
        // FIXME: We should do error-checking here... Especially considering right now we're just
        // forwarding the data.
        this.canvas.push(data);
        for (const participant of this.participants) {
            participant.send(JSON.stringify(data));
        }
    }
}

class MessageError extends Error {}

class Server {
    constructor(port) {
        this.channels = new Map();
        // We're going to start off with a single channel that everyone joins.
        this.channels.set("all", new Channel());

        // Right now, participants can only join a maximum of one channel. This may change in the
        // future.
        this.participants = new Map();

        this.wss = new WebSocket.Server({ port });

        this.wss.on("connection", (ws) => {
            ws.on("message", (message) => {
                try {
                    const data = JSON.parse(message);
                    this.receive_message(ws, data);
                } catch (error) {
                    // Received bad message from client. We should consider doing something if
                    // clients continually misbehave, but we'll simply ignore them for now.
                    console.error(message, error);
                }
            });

            ws.on("close", () => {
                const channel = this.participants.get(ws);
                if (channel !== undefined) {
                    channel.participants.delete(ws);
                }
                if (this.participants.delete(ws)) {
                    console.log("A client left.");
                }
            });
        });
    }

    receive_message(ws, data) {
        // console.log("Received data:", data);
        switch (data.kind) {
            case "join":
                if (!this.participants.has(ws)) {
                    const channel = this.channels.get(data.channel);
                    if (channel !== undefined) {
                        if (channel.admit(ws)) {
                            console.log("A client joined a channel.");
                            this.participants.set(ws, channel);
                        }
                    } else {
                        // The user tried to join a channel that doesn't exist. Like most error
                        // cases, we're just going to ignore it for now.
                        console.error(`A client tried to join a nonexistent channel: "${data.channel}"`);
                    }
                } else {
                    // The user is already in a channel. They can't join another.
                    console.error("A client tried to join a channel while being in another.");
                }
                return;
            case "draw":
                if (this.participants.has(ws)) {
                    const shape = data.shape;
                    if (["circle", "bridge", "clear"].includes(shape)) {
                        const channel = this.participants.get(ws);
                        channel.draw(data);
                    } else {
                        // The user tried to join an invalid shape.
                    }
                } else {
                    // The user is trying to draw something, when they don't
                    // even belong to a channel. How foolish.
                }
                return;
        }
        // All valid arms of the switch return early, so if we get here, then something
        // must be wrong with the message data.
        throw new MessageError();
    }
}

new Server(8080);
