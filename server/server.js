const WebSocket = require("ws");
const readline = require("readline");

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
        // FIXME: the validation is currently duplicated on the client and server. Ideally we
        // would use `import` to share this functionality.
        const validate_data = (properties) => {
            return Server.validate_data(Object.assign({
                kind: () => true, // We're already implicitly validating this property here.
                shape: () => true, // As above.
            }, properties), data);
        };

        const validate_pen_state = (state) => {
            return Server.validate_data({
                x: (x) => Number.isFinite(x),
                y: (y) => Number.isFinite(y),
                tool: (tool) => ["brush", "eraser"].includes(tool),
                colour: (colour) => true, // FIXME: We're not validating colours at the moment.
                radius: (radius) => Number.isFinite(radius) && radius >= 0,
            }, state);
        };

        let valid_data = false;
        switch (data.shape) {
            case "circle":
                valid_data = validate_data({
                    at: validate_pen_state,
                });
                break;
            case "bridge":
                valid_data = validate_data({
                    from: validate_pen_state,
                    to: validate_pen_state,
                });
                break;
            case "clear":
                valid_data = validate_data({});
                break;
        }

        if (valid_data) {
            this.canvas.push(data);
            for (const participant of this.participants) {
                participant.send(JSON.stringify(data));
            }
            if (data.shape === "clear") {
                // Special-case "clear" so that it wipes the history. For now, as we're
                // sending every single message to each client when they join, this should
                // reduce load.
                this.canvas = [];
            }
        }
    }
}

class MessageError extends Error {}

class Server {
    constructor(port) {
        this.channels = new Map();

        // Right now, participants can only join a maximum of one channel. This may change in the
        // future.
        this.participants = new Map();

        this.wss = new WebSocket.Server({ port });

        this.wss.on("connection", (ws) => {
            // We add an extra property, `alive`, to WebSockets for a heartbeat protocol.
            // This ensures clients will not time out if there's no communication for 30 s.
            ws.alive = true;

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
                    // console.log("A client left.");
                }
            });

            ws.on("pong", () => ws.alive = true);
        });

        const SECOND = 1000;
        const HEARTBEAT_INTERVAL = 15 * SECOND;
        setInterval(() => {
            for (const ws of this.wss.clients) {
                if (!ws.alive) {
                    // Timeout unresponsive clients.
                    ws.terminate();
                    continue;
                }
                ws.alive = false;
                ws.ping(null);
            }
        }, HEARTBEAT_INTERVAL);
    }

    static validate_data(sig, data) {
        const properties = new Set(Object.keys(data));
        for (const [key, validator] of Object.entries(sig)) {
            if (properties.delete(key)) {
                if (!validator(data[key])) {
                    // The data value did not pass the validation test. Reject it.
                    return false;
                }
            } else {
                // The data did not include a required field. Reject it.
                return false;
            }
        }
        if (properties.size !== 0) {
            // The data included fields that were not present in the signature. Reject it.
            return false;
        }
        return true;
    }

    receive_message(ws, data) {
        // console.log("Received data:", data);
        switch (data.kind) {
            case "join":
                if (!this.participants.has(ws)) {
                    const channel = this.channels.get(data.channel);
                    if (channel !== undefined) {
                        if (channel.admit(ws)) {
                            // console.log("A client joined a channel.");
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
                    const channel = this.participants.get(ws);
                    channel.draw(data);
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

if (typeof process.env.PORT === "undefined") {
    console.error("You must specify `$PORT` in the environment variables.");
} else {
    const server = new Server(process.env.PORT);

    const add_channel = (name) => {
        const query_string = Buffer.from(`host=${process.env.HOST}&port=${process.env.PORT}&channel=${name}`).toString("base64");
        console.log(`Created channel ${name}, with query string:`, query_string);
        server.channels.set(name, new Channel());
    };

    add_channel("public");

    // New channels can be created from the command line.
    const rl = readline.createInterface(process.stdin, process.stdout);
    rl.setPrompt("quiver> ");
    rl.prompt();
    rl.on("line", (line) => {
        if (/^[a-z0-9_\-]+$/i.test(line)) {
            if (!server.channels.has(line)) {
                add_channel(line);
            } else {
                console.error(`The channel ${line} already exists.`);
            }
        } else {
            console.error("Cannot create a channel with the name: ", line);
        }
        rl.prompt();
    });
}
