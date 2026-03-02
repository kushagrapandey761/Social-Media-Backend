const mongoose = require("mongoose");
const postSchema = new mongoose.Schema({
  content: String,
  media: [Object], // Array of media objects (e.g., { url, type, publicId })
  authorId: mongoose.Schema.Types.ObjectId,
  userName: String,
  userAvatar: String,
  likes: { type: Number, default: 0 },
  comments: [{ type: mongoose.Schema.Types.ObjectId, ref: "Comment" }],
  createdAt: Date,
});

const Post = mongoose.model("Post", postSchema);
module.exports = Post;
