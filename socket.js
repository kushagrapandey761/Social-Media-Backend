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

    // register user
    socket.on("register", (userId) => {
      onlineUsers.set(userId, socket.id);
      io.emit("onlineUsers", Array.from(onlineUsers.keys()));
    });

    socket.on("typing", (data) => {
      const receiverSocket = onlineUsers.get(data.receiverId);
      if (receiverSocket) {
        io.to(receiverSocket).emit("typing", {
          senderId: data.senderId,
          isTyping: true,
        });
      }
    });

    socket.on("stopTyping", (data) => {
      const receiverSocket = onlineUsers.get(data.receiverId);
      if (receiverSocket) {
        io.to(receiverSocket).emit("stopTyping", {
          senderId: data.senderId,
          isTyping: false,
        });
      }
    });

    socket.on("messageSeen", async (data) => {
      const receiverId = data.receiverId;
      const senderId = data.senderId;
      await Message.updateMany(
        { senderId, receiverId, seen: false },
        { $set: { seen: true, seenAt: new Date() } }
      );
      const senderSocket = onlineUsers.get(senderId);
      if (senderSocket) {
        io.to(senderSocket).emit("messageSeen", {
          receiverId,
        });
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
