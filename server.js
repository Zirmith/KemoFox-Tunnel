const express = require('express');
const net = require('net');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

// Load configuration
const config = JSON.parse(fs.readFileSync('config.json'));

const app = express();
const PORT = config.port;
const apiKeyFilePath = path.resolve(__dirname, config.apiKeyFile);

let tunnels = {};

// Load existing API keys
let apiKeys = {};
if (fs.existsSync(apiKeyFilePath)) {
    apiKeys = JSON.parse(fs.readFileSync(apiKeyFilePath));
}

// Save API keys to file
const saveApiKeys = () => {
    fs.writeFileSync(apiKeyFilePath, JSON.stringify(apiKeys, null, 2));
};

app.use(express.json());

// Endpoint to generate a new API key
app.post('/generate-api-key', (req, res) => {
    const { user } = req.body;

    if (!user) {
        return res.status(400).json({ error: 'Missing user' });
    }

    const apiKey = uuidv4();
    apiKeys[apiKey] = { user };

    saveApiKeys();

    res.json({ message: 'API key generated successfully!', apiKey });
});

// Middleware to validate API key
const validateApiKey = (req, res, next) => {
    const apiKey = req.body.apiKey || req.query.apiKey;

    if (!apiKey || !apiKeys[apiKey]) {
        return res.status(403).json({ error: 'Invalid API key' });
    }

    next();
};

// Endpoint to register a new tunnel
app.post('/register', validateApiKey, (req, res) => {
    const { localPort, apiKey } = req.body;

    // Validate the request
    if (!localPort) {
        return res.status(400).json({ error: 'Missing localPort' });
    }

    // Generate a unique ID for the tunnel
    const tunnelId = uuidv4();
    const publicPort = config.initialPublicPort + Object.keys(tunnels).length;

    // Store tunnel information
    tunnels[tunnelId] = {
        localPort,
        publicPort,
        apiKey
    };

    res.json({
        message: 'Tunnel created successfully!',
        tunnelId,
        publicAddress: `${config.publicHost}:${publicPort}`,
        region: config.region,
        statusPage: `http://${config.publicHost}:${PORT}/status/${tunnelId}`
    });

    // Start forwarding traffic from public port to local port
    startForwarding(tunnelId);
});

// Function to start forwarding traffic
const startForwarding = (tunnelId) => {
    const { localPort, publicPort } = tunnels[tunnelId];

    const server = net.createServer((socket) => {
        const client = net.connect(localPort, 'localhost', () => {
            socket.pipe(client);
            client.pipe(socket);
        });

        socket.on('error', (err) => {
            console.error(`Socket error: ${err.message}`);
        });

        client.on('error', (err) => {
            console.error(`Client error: ${err.message}`);
        });
    });

    server.listen(publicPort, () => {
        console.log(`Tunnel ${tunnelId} is forwarding traffic from public port ${publicPort} to local port ${localPort}`);
    });

    tunnels[tunnelId].server = server;
};

// Endpoint to stop a tunnel
app.post('/stop', validateApiKey, (req, res) => {
    const { tunnelId, apiKey } = req.body;

    // Validate the request
    if (!tunnelId) {
        return res.status(400).json({ error: 'Missing tunnelId' });
    }

    const tunnel = tunnels[tunnelId];

    if (!tunnel) {
        return res.status(404).json({ error: 'Tunnel not found' });
    }

    if (tunnel.apiKey !== apiKey) {
        return res.status(403).json({ error: 'Invalid API key' });
    }

    // Stop the server
    tunnel.server.close();
    delete tunnels[tunnelId];

    res.json({ message: 'Tunnel stopped successfully!' });
});

// Endpoint to get tunnel status
app.get('/status/:tunnelId', (req, res) => {
    const { tunnelId } = req.params;

    const tunnel = tunnels[tunnelId];

    if (!tunnel) {
        return res.status(404).json({ error: 'Tunnel not found' });
    }

    res.json({
        tunnelId,
        publicAddress: `${config.publicHost}:${tunnel.publicPort}`,
        localPort: tunnel.localPort,
        region: config.region
    });
});

app.listen(PORT, () => {
    console.log(`Tunneling server is running on port ${PORT}`);
});
