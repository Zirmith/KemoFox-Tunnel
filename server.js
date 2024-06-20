const express = require('express');
const net = require('net');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const getmac = require('getmac').default;

// Load configuration
const config = JSON.parse(fs.readFileSync('config.json'));

const app = express();
const PORT = config.port;
const dbFilePath = path.resolve(__dirname, config.databaseFile);

let tunnels = {};

// Initialize database
const db = new sqlite3.Database(dbFilePath, (err) => {
    if (err) {
        console.error(`Error opening database: ${err.message}`);
    } else {
        db.run(`
            CREATE TABLE IF NOT EXISTS api_keys (
                id TEXT PRIMARY KEY,
                user TEXT,
                mac_address TEXT,
                created_at TEXT
            )
        `);
        db.run(`
            CREATE TABLE IF NOT EXISTS tunnels (
                id TEXT PRIMARY KEY,
                local_port INTEGER,
                public_port INTEGER,
                api_key TEXT,
                created_at TEXT
            )
        `);
    }
});

app.use(express.json());

// Function to fetch external IP
const getExternalIP = async () => {
    try {
        const response = await axios.get('https://ipinfo.io/json');
        return response.data.ip;
    } catch (error) {
        console.error('Error fetching external IP:', error);
        return null;
    }
};

// Endpoint to generate a new API key
app.post('/generate-api-key', async (req, res) => {
    const { user } = req.body;

    if (!user) {
        return res.status(400).json({ error: 'Missing user' });
    }

    try {
        const apiKey = uuidv4();
        const externalIP = await getExternalIP();
        const createdAt = new Date().toISOString();

        db.run(`
            INSERT INTO api_keys (id, user, ip_address, created_at) 
            VALUES (?, ?, ?, ?)
        `, [apiKey, user, externalIP, createdAt], function (err) {
            if (err) {
                return res.status(500).json({ error: 'Failed to generate API key' });
            }

            res.json({ message: 'API key generated successfully!', apiKey });
        });
    } catch (error) {
        console.error('Error generating API key:', error);
        return res.status(500).json({ error: 'Failed to generate API key' });
    }
});


// Middleware to validate API key
const validateApiKey = (req, res, next) => {
    const apiKey = req.body.apiKey || req.query.apiKey;

    if (!apiKey) {
        return res.status(403).json({ error: 'Missing API key' });
    }
    db.get(`SELECT * FROM api_keys WHERE id = ?`, [apiKey], (err, row) => {
        if (err || !row) {
            return res.status(403).json({ error: 'Invalid API key' });
        }
        next();
    });
};

// Endpoint to register a new tunnel
app.post('/register', validateApiKey, async (req, res) => {
    const { localPort, apiKey } = req.body;

    // Validate the request
    if (!localPort) {
        return res.status(400).json({ error: 'Missing localPort' });
    }

    // Generate a unique ID for the tunnel
    const tunnelId = uuidv4();
    const publicPort = config.initialPublicPort + Object.keys(tunnels).length;
    const createdAt = new Date().toISOString();
    const externalIP = await getExternalIP();

    // Store tunnel information
    tunnels[tunnelId] = {
        localPort,
        publicPort,
        apiKey
    };

    db.run(`
        INSERT INTO tunnels (id, local_port, public_port, api_key, created_at) 
        VALUES (?, ?, ?, ?, ?)
    `, [tunnelId, localPort, publicPort, apiKey, createdAt], function (err) {
        if (err) {
            return res.status(500).json({ error: 'Failed to create tunnel' });
        }

        res.json({
            message: 'Tunnel created successfully!',
            tunnelId,
            publicAddress: `${externalIP}:${publicPort}`,
            region: config.region,
            statusPage: `http://${externalIP}:${PORT}/status/${tunnelId}`
        });

        // Start forwarding traffic from public port to local port
        startForwarding(tunnelId);
    });
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

    db.run(`DELETE FROM tunnels WHERE id = ?`, [tunnelId], function (err) {
        if (err) {
            return res.status(500).json({ error: 'Failed to stop tunnel' });
        }

        res.json({ message: 'Tunnel stopped successfully!' });
    });
});

// Middleware to retrieve API key and user based on client IP
const retrieveApiKeyAndUser = async (req, res, next) => {
    const externalIP = await getExternalIP();

    db.get(`SELECT * FROM api_keys WHERE ip_address = ?`, [externalIP], (err, row) => {
        if (err || !row) {
            return res.status(403).json({ error: 'No API key found for this IP' });
        }

        req.apiKey = row.id;
        req.user = row.user;
        next();
    });
};


// Endpoint to get API key and user based on client IP
app.get('/mykey', retrieveApiKeyAndUser, (req, res) => {
    res.json({
        apiKey: req.apiKey,
        user: req.user
    });
});

// Endpoint to get tunnel status
app.get('/status/:tunnelId', (req, res) => {
    const { tunnelId } = req.params;

    db.get(`SELECT * FROM tunnels WHERE id = ?`, [tunnelId], (err, tunnel) => {
        if (err || !tunnel) {
            return res.status(404).json({ error: 'Tunnel not found' });
        }

        res.json({
            tunnelId,
            publicAddress: `${config.publicHost}:${tunnel.public_port}`,
            localPort: tunnel.local_port,
            region: config.region
        });
    });
});

app.listen(PORT, async () => {
    const externalIP = await getExternalIP();
    console.log(`Tunneling server is running on port ${PORT} with external IP ${externalIP}`);
});

   
