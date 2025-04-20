const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// Create Express app
const app = express();
app.use(cors());

// Create HTTP server
const server = http.createServer(app);

// Create Socket.IO server
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || '*',
    methods: ['GET', 'POST'],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

// Store active sessions
const sessions = new Map();

// Session timeout (10 seconds)
const SESSION_TIMEOUT = 60000;

// Add a simple health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', sessions: sessions.size });
});

// Add a root endpoint with basic info
app.get('/', (req, res) => {
  res.status(200).json({ 
    name: 'QR Code Camera Signaling Server',
    status: 'running',
    activeSessions: sessions.size
  });
});

// Socket.IO connection handler
io.on('connection', (socket) => {
  console.log('✅ New client connected:', socket.id);
  
  // Handle new connection
  socket.on('create-session', () => {
    const sessionId = uuidv4();
    sessions.set(sessionId, {
      desktop: socket.id,
      mobile: null,
      ready: false,
      pendingSignals: [], // Buffer for early signals
      created: Date.now(),
      timeout: setTimeout(() => {
        // Remove session after timeout
        if (sessions.has(sessionId)) {
          const session = sessions.get(sessionId);
          if (session && !session.mobile) {
            io.to(session.desktop).emit('session-timeout');
            sessions.delete(sessionId);
            console.log('⏱️ Session timed out:', sessionId);
          }
        }
      }, SESSION_TIMEOUT)
    });
    
    console.log('✅ Session created:', sessionId);
    socket.emit('session-created', { sessionId });
  });

  // Handle mobile connection
  socket.on('join-session', ({ sessionId }) => {
    console.log('🔍 Join session attempt:', sessionId);
    if (sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      if (session) {
        // Clear timeout as connection is established
        clearTimeout(session.timeout);
        
        // Update session with mobile socket id
        session.mobile = socket.id;
        // Mark session as ready
        session.ready = true;
        
        console.log('✅ Mobile connected to session:', sessionId);
        
        // Notify desktop that mobile has connected
        io.to(session.desktop).emit('mobile-connected');
        
        // Notify mobile that connection is successful
        socket.emit('connection-successful');

        // Send any pending signals
        if (session.pendingSignals.length > 0) {
          console.log('Sending pending signals:', session.pendingSignals.length);
          session.pendingSignals.forEach(signal => {
            io.to(signal.targetId).emit('signal', { signal: signal.data });
          });
          session.pendingSignals = [];
        }
      }
    } else {
      console.log('❌ Session not found:', sessionId);
      socket.emit('session-not-found');
    }
  });

  // Handle WebRTC signaling
  socket.on('signal', ({ sessionId, signal }) => {
    console.log('🔍 Signal received for session:', sessionId);
    if (sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      if (session) {
        const targetId = socket.id === session.desktop ? session.mobile : session.desktop;
        
        if (!session.ready) {
          // Buffer the signal if session isn't ready
          console.log('⏳ Buffering early signal');
          session.pendingSignals.push({ targetId, data: signal });
          return;
        }

        if (targetId) {
          console.log('✅ Forwarding signal to:', targetId);
          io.to(targetId).emit('signal', { signal });
        } else {
          console.log('❌ Target not found for signal');
        }
      }
    } else {
      console.log('❌ Session not found for signal:', sessionId);
    }
  });

  // Handle disconnection
  socket.on('disconnect', (reason) => {
    console.log('🔍 Client disconnected:', socket.id, 'Reason:', reason);
    // Find and clean up any sessions this socket was part of
    for (const [sessionId, session] of sessions.entries()) {
      if (session.desktop === socket.id || session.mobile === socket.id) {
        const targetId = socket.id === session.desktop ? session.mobile : session.desktop;
        
        if (targetId) {
          console.log('✅ Notifying peer of disconnection:', targetId);
          io.to(targetId).emit('peer-disconnected');
        }
        
        console.log('✅ Removing session:', sessionId);
        sessions.delete(sessionId);
        break;
      }
    }
  });

  // Handle errors
  socket.on('error', (error) => {
    console.error('❌ Socket error:', error);
  });
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Signaling server running on port ${PORT}`);
});