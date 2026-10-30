const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cors = require('cors');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const User = require('./models/User');
const LiveSession = require('./models/LiveSession');

dotenv.config();

// Ensure uploads folder exists
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

const app = express();
const server = http.createServer(app);
const allowedOrigins = (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',').map(x => x.trim());
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
  }
});

app.use(cors({ origin: allowedOrigins }));
app.use(express.json());
app.use('/uploads', (req, res, next) => (req.path.startsWith('/library/') || req.path.startsWith('/learning/') || req.path.startsWith('/submissions/')) ? res.sendStatus(404) : next(), express.static(path.join(__dirname, 'uploads')));

// Make io accessible in routes
app.set('io', io);

io.use(async (socket, next) => {
  try {
    if (!process.env.JWT_SECRET) return next(new Error('Authentication required'));
    const token = socket.handshake.auth?.token;
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('name role status isApproved');
    if (!user || user.status !== 'active' || (['faculty','instructor'].includes(user.role) && !user.isApproved)) return next(new Error('Authentication required'));
    socket.data.user = user;
    next();
  } catch { next(new Error('Authentication required')); }
});

const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/mern-lms';

// Refuse API work while MongoDB is disconnected instead of letting Mongoose buffer requests.
app.use('/api', (req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ success: false, message: 'Database is not connected. Wait for MongoDB connected in the backend terminal and retry.' });
  }
  next();
});

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/courses', require('./routes/courses'));
app.use('/api/modules', require('./routes/modules'));
app.use('/api/tests', require('./routes/tests'));
app.use('/api/users', require('./routes/users'));
app.use('/api/discussions', require('./routes/discussions'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/progress', require('./routes/progress'));
app.use('/api/tracking', require('./routes/tracking'));
app.use('/api/workspace', require('./routes/workspace'));
app.use('/api/certificates', require('./routes/certificates'));
// Socket.io for live class and chat
io.on('connection', (socket) => {
  socket.on('join-live', async (roomId) => {
    if (typeof roomId !== 'string' || roomId.length > 100) return;
    const session = await LiveSession.findOne({ roomId }).populate({ path: 'module', populate: { path: 'course' } });
    const course = session?.module?.course;
    const user = socket.data.user;
    if (!course || (user.role !== 'admin' && String(course.faculty) !== String(user._id) && !course.students.some(id => String(id) === String(user._id)))) return;
    socket.join(roomId);
    socket.to(roomId).emit('user-joined', { name: user.name });
  });

  socket.on('send-message', ({ roomId, message } = {}) => {
    if (typeof roomId !== 'string' || !socket.rooms.has(roomId) || typeof message !== 'string') return;
    const safeMessage = message.trim().slice(0, 1000);
    if (safeMessage) io.to(roomId).emit('receive-message', { message: safeMessage, senderName: socket.data.user.name });
  });
});


app.get("/", (req, res) => {
  res.send("Backend API is running successfully");
});

const PORT = process.env.PORT || 5000;
app.use((err, req, res, next) => {
  console.error(err.message);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ success: false, message: err.status ? err.message : 'Something went wrong. Please try again.' });
});
async function startServer() {
  try {
    await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 10000 });
    console.log('MongoDB connected');
    server.listen(PORT, () => console.log('Server running on port ' + PORT));
  } catch (error) {
    console.error('MongoDB connection error:', error.message);
    process.exit(1);
  }
}

startServer();

