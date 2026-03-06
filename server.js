const WebSocket = require('ws');
const http = require('http');

// Create HTTP server
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WebRTC Signaling Server is running');
});

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Store connected peers
const peers = new Map(); // peerId -> WebSocket connection

console.log('WebRTC Signaling Server starting...');

wss.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress;
    console.log(`New connection from ${clientIp}`);

    let peerId = null;

    ws.on('message', (message) => {
        try {
            const msgString = message.toString();

            // Pipe-delimited format: TYPE|SenderPeerId|ReceiverPeerId|Message|ConnectionCount|IsVideoAudioSender
            if (msgString.includes('|')) {
                const parts = msgString.split('|');
                const messageType = parts[0];
                const senderPeerId = parts[1];
                const receiverPeerId = parts[2];

                console.log(`Received ${messageType} from ${senderPeerId} to ${receiverPeerId}`);

                switch (messageType) {
                    case 'NEWPEER':
                        peerId = senderPeerId;
                        peers.set(peerId, ws);
                        console.log(`✓ Peer registered: ${peerId} (Total peers: ${peers.size})`);

                        // Notify all other peers — preserve original message so IsVideoAudioSender flag is kept
                        peers.forEach((otherWs, otherPeerId) => {
                            if (otherPeerId !== peerId && otherWs.readyState === WebSocket.OPEN) {
                                otherWs.send(msgString); // ← forward original, not rewritten
                            }
                        });
                        break;

                    case 'NEWPEERACK':
                        // Forward to all other peers so Unity receives the ACK and sends OFFER
                        peers.forEach((otherWs, otherPeerId) => {
                            if (otherPeerId !== peerId && otherWs.readyState === WebSocket.OPEN) {
                                otherWs.send(msgString);
                            }
                        });
                        break;

                    case 'OFFER':
                        forwardPipeMessage(receiverPeerId, msgString);
                        break;

                    case 'ANSWER':
                        forwardPipeMessage(receiverPeerId, msgString);
                        break;

                    case 'CANDIDATE':
                        forwardPipeMessage(receiverPeerId, msgString);
                        break;

                    case 'DATA':
                        if (receiverPeerId && receiverPeerId !== 'ALL') {
                            forwardPipeMessage(receiverPeerId, msgString);
                        } else {
                            broadcastPipeMessage(msgString, senderPeerId);
                        }
                        break;

                    case 'DISPOSE':
                        forwardPipeMessage(receiverPeerId, msgString);
                        break;

                    case 'COMPLETE':
                        forwardPipeMessage(receiverPeerId, msgString);
                        break;

                    default:
                        console.log(`Unknown pipe message type: ${messageType}`);
                }

            } else {
                // JSON format (web test client compatibility)
                const data = JSON.parse(msgString);
                console.log(`Received JSON message type: ${data.type} from ${data.from || 'unknown'}`);

                switch (data.type) {
                    case 'register':
                        peerId = data.peerId;
                        peers.set(peerId, ws);
                        console.log(`Peer registered: ${peerId} (Total peers: ${peers.size})`);

                        ws.send(JSON.stringify({ type: 'registered', peerId, success: true }));

                        const otherPeers = Array.from(peers.keys()).filter(id => id !== peerId);
                        ws.send(JSON.stringify({ type: 'peer-list', peers: otherPeers }));

                        broadcastToPeers({ type: 'peer-connected', peerId }, peerId);
                        break;

                    case 'offer':
                        forwardToPeer(data.to, { type: 'offer', from: data.from, offer: data.offer });
                        break;

                    case 'answer':
                        forwardToPeer(data.to, { type: 'answer', from: data.from, answer: data.answer });
                        break;

                    case 'ice-candidate':
                        forwardToPeer(data.to, { type: 'ice-candidate', from: data.from, candidate: data.candidate });
                        break;

                    case 'data':
                        if (data.to) {
                            forwardToPeer(data.to, { type: 'data', from: data.from, message: data.message });
                        } else {
                            broadcastToPeers({ type: 'data', from: data.from, message: data.message }, data.from);
                        }
                        break;

                    default:
                        console.log(`Unknown JSON message type: ${data.type}`);
                }
            }
        } catch (error) {
            console.error('Error processing message:', error, 'Raw message:', message.toString());
        }
    });

    ws.on('close', () => {
        if (peerId) {
            peers.delete(peerId);
            console.log(`Peer disconnected: ${peerId} (Total peers: ${peers.size})`);

            peers.forEach((otherWs, otherPeerId) => {
                if (otherWs.readyState === WebSocket.OPEN) {
                    otherWs.send(`DISPOSE|${peerId}|${otherPeerId}|Peer disconnected|0|false`);
                }
            });

            broadcastToPeers({ type: 'peer-disconnected', peerId }, peerId);
        }
    });

    ws.on('error', (error) => {
        console.error(`WebSocket error for peer ${peerId}:`, error);
    });
});

function forwardToPeer(targetPeerId, message) {
    const targetWs = peers.get(targetPeerId);
    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify(message));
        console.log(`Forwarded ${message.type} from ${message.from} to ${targetPeerId}`);
    } else {
        console.log(`Target peer ${targetPeerId} not found or not ready`);
    }
}

function forwardPipeMessage(targetPeerId, message) {
    const targetWs = peers.get(targetPeerId);
    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(message);
        const parts = message.split('|');
        console.log(`Forwarded ${parts[0]} from ${parts[1]} to ${targetPeerId}`);
    } else {
        console.log(`Target peer ${targetPeerId} not found or not ready`);
    }
}

function broadcastToPeers(message, excludePeerId) {
    peers.forEach((ws, peerId) => {
        if (peerId !== excludePeerId && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
        }
    });
}

function broadcastPipeMessage(message, excludePeerId) {
    peers.forEach((ws, peerId) => {
        if (peerId !== excludePeerId && ws.readyState === WebSocket.OPEN) {
            ws.send(message);
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✓ WebRTC Signaling Server running on port ${PORT}`);
    console.log(`WebSocket URL: ws://localhost:${PORT}`);
    console.log(`For HTTPS: wss://your-domain.com:${PORT}`);
});

process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => console.log('HTTP server closed'));
});