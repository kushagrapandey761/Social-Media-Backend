const express = require("express");
const authMiddleware = require("../../middleware/authMiddleware");
const { Message } = require("../../db");
const { getIO, getOnlineUsers } = require("../../socket");

const router = express.Router();

router.post("/sendMessage", authMiddleware, async (req, res) => {
  const { receiverId, text, postId, type, currentMediaIndex } = req.body;
  const senderId = req.session.user.id;

  if ((!text && !postId) || (text && postId)) {
    return res.status(400).json({
      message: "Send either text or post, not both",
    });
  }

  const message = await Message.create({
    senderId,
    receiverId,
    text: text || "",
    postId: postId || null,
    type,
    currentMediaIndex: currentMediaIndex !== undefined ? currentMediaIndex : null,
    seen: false,
  });

  const populatedMessage = await Message.findById(message._id).populate({
    path: "postId",
    select: "content media userName userAvatar",
  });
  const onlineUsers = getOnlineUsers();
  const receiverSocket = onlineUsers.get(receiverId);

  if (receiverSocket) {
    const io = getIO();
    io.to(receiverSocket).emit("receiveMessage", populatedMessage);
  }

  res.json(populatedMessage);
});

router.get("/messages/:userId", authMiddleware, async (req, res) => {
  const currentUserId = req.session.user.id;
  const otherUserId = req.params.userId;
  try {
    const messages = await Message.find({
      $or: [
        { senderId: currentUserId, receiverId: otherUserId },
        { senderId: otherUserId, receiverId: currentUserId },
      ],
    })
      .sort({ createdAt: 1 })
      .populate({ path: "postId", select: "content media userName userAvatar" });
    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/messages/unseen/count", authMiddleware, async (req, res) => {
  const currentUserId = req.session.user.id;
  try {
    const count = await Message.countDocuments({
      receiverId: currentUserId,
      seen: false,
    });

    res.json({ count });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/messages/unseen/users", authMiddleware, async (req, res) => {
  const currentUserId = req.session.user.id;
  try {
    const senderIds = await Message.find({
      receiverId: currentUserId,
      seen: false,
    }).select("senderId");
    res.json({ senderIds });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
