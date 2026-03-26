const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema({
  senderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },

  receiverId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },

  text: {
    type: String,
  },

  media: {
    type: String,
  },

  seen: {
    type: Boolean,
    default: false,
  },
  
  seenAt: {
    type: Date,
  },

  postId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Post",
    default: null,
  },

  type: {
    type: String,
    enum: ["text", "post"],
    required: true,
  },

  currentMediaIndex: {
    type: Number,
    default: null
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("Message", messageSchema);
