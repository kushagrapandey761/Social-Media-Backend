const mongoose = require("mongoose");
const postSchema = new mongoose.Schema({
  title: String,
  content: String,
  media: [Object], // Array of media objects (e.g., { url, type, publicId })
  authorId: mongoose.Schema.Types.ObjectId,
  createdAt: Date,
});

const Post = mongoose.model("Post", postSchema);
module.exports = Post;
