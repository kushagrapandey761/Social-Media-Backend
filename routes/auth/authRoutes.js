const express = require("express");
const bcryptjs = require("bcryptjs");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const passport = require("../../passport");
const { User } = require("../../db");
const authMiddleware = require("../../middleware/authMiddleware");

const router = express.Router();

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: `${process.env.SENDER_EMAIL}`,
    pass: `${process.env.SENDER_PASSWORD}`,
  },
});

router.post("/login", async (req, res) => {
  const user = await User.findOne({ email: req.body.email });
  if (!user) return res.status(401).send("Invalid credentials");

  const isPasswordValid = await bcryptjs.compare(req.body.password, user.password);
  if (!isPasswordValid) {
    return res.status(401).send("Invalid credentials");
  }

  req.session.user = {
    id: user._id,
    username: user.username,
  };

  req.session.save((err) => {
    if (err) return res.status(500).json({ error: "Failed to save session" });
    res.json({ message: "Logged in" });
  });
});

router.post("/signup", async (req, res) => {
  const { name, username, email, password } = req.body;
  let existingUser = await User.findOne({ email, username });
  if (existingUser) {
    return res.status(400).json({ message: "Email already in use" });
  }
  existingUser = await User.findOne({ username });
  if (existingUser) {
    return res.status(400).json({ message: "Username already in use" });
  }

  const hashedPassword = await bcryptjs.hash(password, parseInt(process.env.SALT_ROUNDS));

  const user = new User({
    name,
    username,
    email,
    password: hashedPassword,
    userAvatar: "",
    bio: "",
  });
  await user.save();
  res.json({ message: "User created" });
});

router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;

  const user = await User.findOne({ email });

  if (!user) {
    return res.json({ message: "If email exists, reset link sent" });
  }

  const token = crypto.randomBytes(32).toString("hex");

  user.resetPasswordToken = token;
  user.resetPasswordExpires = Date.now() + 1000 * 60 * 15;

  await user.save();

  const resetLink = `${process.env.FRONTEND_LINK}/reset-password/${token}`;

  await transporter.sendMail({
    to: user.email,
    subject: "Reset Password",
    html: `<a href="${resetLink}">Reset Password</a>`,
  });

  res.json({ message: "Reset link sent" });
});

router.post("/reset-password/:token", async (req, res) => {
  const { token } = req.params;
  const { password } = req.body;

  const user = await User.findOne({
    resetPasswordToken: token,
    resetPasswordExpires: { $gt: Date.now() },
  });

  if (!user) {
    return res.status(400).json({ message: "Invalid or expired token" });
  }

  const hashedPassword = await bcryptjs.hash(password, parseInt(process.env.SALT_ROUNDS));

  user.password = hashedPassword;
  user.resetPasswordToken = undefined;
  user.resetPasswordExpires = undefined;

  await user.save();

  res.json({ message: "Password reset successful" });
});

router.post("/logout", authMiddleware, (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: "Failed to logout" });
    res.clearCookie("connect.sid");
    res.json({ message: "Logged out" });
  });
});

router.get(
  "/auth/google",
  passport.authenticate("google", {
    scope: ["profile", "email"],
  }),
);

router.get(
  "/auth/google/callback",
  passport.authenticate("google", {
    failureRedirect: "/login",
  }),
  (req, res) => {
    req.session.user = {
      id: req.user._id,
      username: req.user.username,
    };

    req.session.save((err) => {
      if (err) console.error("Session save error:", err);
      res.redirect(process.env.FRONTEND_LINK);
    });
  },
);

module.exports = router;
