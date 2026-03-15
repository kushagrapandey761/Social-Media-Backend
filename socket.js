const { Server } = require("socket.io");
const { Message } = require("./db");

let io;

// Map to store online users
const onlineUsers = new Map();

function initSocket(server) {
  io = new Server(server, {
    cors: {
      origin: "http://localhost:3000",
      credentials: true,
    },
  });

  io.on("connection", (socket) => {

    socket.on("register", (userId) => {
      onlineUsers.set(userId, socket.id);
      socket.userId = userId;
      io.emit("onlineUsers", Array.from(onlineUsers.keys()));
    });

    socket.on("typing", (data) => {
      const receiverSocket = onlineUsers.get(data.receiverId);
      if (receiverSocket && socket.userId) {
        io.to(receiverSocket).emit("typing", {
          senderId: socket.userId,
          isTyping: true,
        });
      }
    });

    socket.on("stopTyping", (data) => {
      const receiverSocket = onlineUsers.get(data.receiverId);
      if (receiverSocket && socket.userId) {
        io.to(receiverSocket).emit("stopTyping", {
          senderId: socket.userId,
          isTyping: false,
        });
      }
    });

    socket.on("messageSeen", async ({ senderId }) => {
      const receiverId = socket.userId;
      if (!receiverId) return;

      await Message.updateMany(
        { senderId, receiverId, seen: false },
        { $set: { seen: true, seenAt: new Date() } }
      );
      
      const senderSocket = onlineUsers.get(senderId);
      if (senderSocket) {
        io.to(senderSocket).emit("messageSeen", { receiverId });
      }
    });

    // disconnect
    socket.on("disconnect", () => {

      for (const [userId, socketId] of onlineUsers.entries()) {
        if (socketId === socket.id) {
          onlineUsers.delete(userId);
          break;
        }
      }
      io.emit("onlineUsers", Array.from(onlineUsers.keys()));
    });
  });

  return io;
}

function getIO() {
  if (!io) {
    throw new Error("Socket.io not initialized");
  }
  return io;
}

function getOnlineUsers() {
  return onlineUsers;
}

module.exports = { initSocket, getIO, getOnlineUsers };
