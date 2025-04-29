const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/user');
const router = express.Router();
const jwt=require("jsonwebtoken");
const { authenticateToken } = require('./jwt');

JWT_SECRET="679992956"
const tokenBlacklist = new Set();




  

// Register
router.post('/register', async (req, res) => {
    const { username,mobile, email, password } = req.body;
    try {
        let user = await User.findOne({ email });
        if (user) return res.status(400).json({ msg: 'User already exists' });

        user = new User({
            email,
            password: await bcrypt.hash(password, 10),
            username,mobile
        });

        await user.save();
        res.json({ message: 'User registered successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

//login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
      // Find the user by email
      const user = await User.findOne({ email: email });
      if (
          !user ||
          !(await user.comparePassword(password)) ||
          !["admin", "master-admin"].includes(user.usertype)
      ) {
          // User not found, password does not match, or not authorized
          return res
              .status(400)
              .json({ error: "Invalid username or password or not authorized" });
      }
      
      const token = jwt.sign({ username: user.email,role: user.usertype  }, JWT_SECRET);
      res.status(200).json({ token,role:user.usertype,name:user.username, msg: "User login successfully" });
  } catch (err) {
      // Handle any unexpected errors
      res.status(500).json({ error: err.message });
  }
});
//update-role
router.post('/update-role', authenticateToken, async (req, res) => {
    const { email, role } = req.body;
  
    try {
      const currentUser = req.user;
      if (!currentUser || currentUser.role !== 'master-admin') {
        return res.status(403).json({ error: 'Unauthorized to change roles' });
      }
  
      if (!['user', 'admin'].includes(role)) {
        return res.status(400).json({ error: 'Invalid role' });
      }
  
      const user = await User.findOneAndUpdate(
        { email },
        { usertype: role },
        { new: true, runValidators: true }
      );
  
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
  
      res.status(200).json({ msg: 'Role updated successfully' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
//User-info
  router.get('/users', authenticateToken, async (req, res) => {
    try {
      const currentUser = req.user;
      if (!currentUser || !['admin', 'master-admin'].includes(currentUser.role)) {
        return res.status(403).json({ error: 'Unauthorized to view users' });
      }
  
      const { search } = req.query;
      let query = { usertype: { $ne: 'master-admin' } }; // Exclude master-admin users
  
      if (search) {
        const searchRegex = new RegExp(search, 'i'); // Case-insensitive search
        query.$or = [
          { username: searchRegex },
          { email: searchRegex }
        ];
      }
  
      const users = await User.find(query, 'username email usertype lastActive');
      res.status(200).json(users);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  
//logout
router.post('/logout',authenticateToken, (req, res) => {
    const authorization = req.headers.authorization;
    if (!authorization) {
      return res.status(400).send('Authorization header missing');
    }
  
    const token = req.headers.authorization.split(' ')[1];
    
    tokenBlacklist.add(token);
    
    
    res.status(200).send('Logged out successfully');
  });
module.exports = router;
