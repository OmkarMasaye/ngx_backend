const express = require('express');
const { MongoClient } = require('mongodb');
const { parse } = require('json2csv');
const routes = express.Router();
const {authenticateToken} = require('./jwt'); 
const moment = require('moment-timezone');

const skodaDbUrl = "mongodb://localhost:27017/skoda"; 

const loanUrl = "mongodb://localhost:27017/skoda";
const collectionNames = {
  skoda: "skoda", // Replace with your Skoda collection name
  tata: "tata_ev_leads",
  loan: "loan", // Replace with your Tata collection name
};
async function getDatabase(dataName) {
  let dbUrl;

  if (dataName === "skoda") {
    dbUrl = skodaDbUrl; // Ensure this variable is defined correctly
  } else if (dataName === "tata") {
    dbUrl = tataDbUrl; // Ensure this variable is defined correctly
  } else if (dataName === "loan") {
    dbUrl = loanUrl; // Ensure this variable is defined correctly
  } else {
    throw new Error("Unknown data name");
  }

  try {
    // Connect to the respective MongoDB database
    const client = await MongoClient.connect(dbUrl);
    return client.db(); // Returns the database instance
  } catch (err) {
    throw new Error("Failed to connect to the database: " + err.message);
  }
}
//Viewdata and Download 
routes.get('/viewdata/:dataName', authenticateToken, async (req, res) => {
  const { dataName } = req.params;
  const format = req.query.format || 'json';
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip = (page - 1) * limit;
  const sortBy = req.query.sortBy || 'createdAt';
  const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;

  const name = req.query.name ? req.query.name.trim() : '';
  const email = req.query.email ? req.query.email.trim() : '';
  const mobile = req.query.mobile ? req.query.mobile.trim() : '';
  const app_id = req.query.app_id ? req.query.app_id.trim() : '';

  const dateRange = req.query.dateRange;
  const customStart = req.query.customStartDate
    ? new Date(Date.parse(req.query.customStartDate + 'T00:00:00Z'))
    : null;
  const customEnd = req.query.customEndDate
    ? new Date(Date.parse(req.query.customEndDate + 'T23:59:59Z'))
    : null;

  try {
    const db = await getDatabase(dataName);
    const collectionName = collectionNames[dataName];

    if (!collectionName) {
      return res.status(404).send(`No collection found for data name: ${dataName}`);
    }

    const collection = db.collection(collectionName);

    const filter = {};
    if (name) filter['name'] = { $regex: name, $options: 'i' };
    if (email) filter['email'] = { $regex: email, $options: 'i' };

    const aggregationPipeline = [
      { $match: filter },
      {
        $addFields: {
          mobileStr: { $toString: '$mobile' },
          appIdStr: { $toString: '$app_id' }
        }
      }
    ];

    if (mobile) {
      aggregationPipeline.push({
        $match: { mobileStr: { $regex: `^${mobile}`, $options: 'i' } }
      });
    }

    if (app_id) {
      aggregationPipeline.push({
        $match: { appIdStr: { $regex: `^${app_id}`, $options: 'i' } }
      });
    }

    const now = new Date();
    if (dateRange === 'today') {
      const startOfDay = new Date(now.setHours(0, 0, 0, 0));
      const endOfDay = new Date(now.setHours(23, 59, 59, 999));
      filter['createdAt'] = { $gte: startOfDay, $lte: endOfDay };
    } else if (dateRange === 'thisWeek') {
      const startOfWeek = new Date(now);
      startOfWeek.setDate(now.getDate() - now.getDay());
      startOfWeek.setHours(0, 0, 0, 0);
      const endOfWeek = new Date(startOfWeek);
      endOfWeek.setDate(startOfWeek.getDate() + 6);
      endOfWeek.setHours(23, 59, 59, 999);
      filter['createdAt'] = { $gte: startOfWeek, $lte: endOfWeek };
    } else if (dateRange === 'thisMonth') {
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      endOfMonth.setHours(23, 59, 59, 999);
      filter['createdAt'] = { $gte: startOfMonth, $lte: endOfMonth };
    } else if (dateRange === 'custom' && customStart && customEnd) {
      filter['createdAt'] = { $gte: customStart, $lte: customEnd };
    }

    aggregationPipeline.push({ $match: filter }, { $sort: { [sortBy]: sortOrder } });

    if (format !== 'csv' && format !== 'json') {
      return res.status(400).send('Invalid format specified');
    }

    if (format !== 'csv') {
      aggregationPipeline.push({ $skip: skip }, { $limit: limit });
    }

    let data = await collection.aggregate(aggregationPipeline).toArray();
    let totalRecords = await collection.countDocuments(filter);
    const totalPages = Math.ceil(totalRecords / limit);

    if (format === 'csv') {
      try {
        const csv = parse(data); // Remove explicit fields to include all fields
        res.header('Content-Type', 'text/csv');
        res.attachment(`${dataName}.csv`);
        return res.send(csv);
      } catch (err) {
        return res.status(500).send('Error generating CSV');
      }
    } else {
      const responseData = {
        data,
        totalRecords,
        totalPages,
        currentPage: page
      };
      return res.json(responseData);
    }
  } catch (error) {
    console.error('Error fetching data:', error);
    return res.status(500).send(`Error fetching data: ${error.message}`);
  }
});
//loan dashboard
routes.get('/api/dashboard', async (req, res) => {
  try {
    const db = await getDatabase('loan');
    const collection = db.collection(collectionNames.loan);

    // Total Applications
    const totalApplications = await collection.countDocuments();

    // Average Credit Score
    const creditScoreAgg = await collection.aggregate([
      { $match: { "data.credit_score": { $exists: true } } },
      { $group: { _id: null, avgCreditScore: { $avg: "$data.credit_score" } } }
    ]).toArray();
    const averageCreditScore = creditScoreAgg.length > 0 ? Math.round(creditScoreAgg[0].avgCreditScore) : 0;

    // Application Status
    const statusAgg = await collection.aggregate([
      { $group: { _id: "$approval.status", count: { $sum: 1 } } }
    ]).toArray();
    const status = { Approved: 0, Pending: 0, Rejected: 0 };
    statusAgg.forEach(item => {
      status[item._id] = item.count;
    });

    // Geographic Distribution (Only valid Indian states)
    const geoAgg = await collection.aggregate([
      { $match: { "d.comm_state": { $ne: null, $exists: true } } },
      { $group: { _id: "$d.comm_state", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 }
    ]).toArray();
    const stateNames = {
      "1": "Punjab", "2": "Haryana", "3": "Rajasthan", "4": "Uttar Pradesh", "5": "Bihar",
      "6": "Madhya Pradesh", "7": "Maharashtra", "8": "Gujarat", "9": "Delhi", "10": "West Bengal",
      "11": "Odisha", "12": "Kerala", "13": "Tamil Nadu", "14": "Karnataka", "15": "Andhra Pradesh",
      "16": "Telangana", "17": "Assam", "18": "Jharkhand", "19": "Chhattisgarh", "20": "Uttarakhand",
      "21": "Himachal Pradesh", "22": "Jammu and Kashmir", "23": "Tamil Nadu", "24": "Goa"
    };
    const geographicDistribution = {};
    geoAgg.forEach(item => {
      if (stateNames[item._id]) {
        geographicDistribution[stateNames[item._id]] = item.count;
      }
    });

    // Recent Activity (Using email instead of approval status, date instead of time)
    const recentActivity = await collection.find()
      .sort({ lastHit: -1 })
      .limit(5)
      .toArray();
    const formattedActivity = recentActivity.map(item => ({
      name: item.name,
      email: item.email,
      date: new Date(item.lastHit).toLocaleDateString()
    }));

    // Mock percentage changes (since we don't have historical data)
    const totalApplicationsChange = 12;
    const averageCreditScoreChange = -3;

    res.json({
      totalApplications,
      totalApplicationsChange,
      averageCreditScore,
      averageCreditScoreChange,
      status,
      geographicDistribution,
      recentActivity: formattedActivity
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

//skoda dashboard
routes.get('/api/skoda-dashboard', async (req, res) => {
  try {
    const db = await getDatabase('skoda');
    const collection = db.collection(collectionNames.skoda);

    // Total Leads
    const totalLeads = await collection.countDocuments();

    // Model Distribution (Only Slavia, Kushaq, Kodiaq)
    const modelAgg = await collection.aggregate([
      { $match: { model: { $in: ["Slavia", "Kushaq", "Kodiaq"] } } },
      { $group: { _id: "$model", count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]).toArray();
    const modelDistribution = {};
    modelAgg.forEach(item => {
      modelDistribution[item._id] = item.count;
    });

    // Lead Status (Based on reason field: success -> Accepted, rejected -> Rejected)
    const statusAgg = await collection.aggregate([
      { $group: { _id: "$reason", count: { $sum: 1 } } }
    ]).toArray();
    const status = { Approved: 0, Pending: 0, Rejected: 0 };
    statusAgg.forEach(item => {
      if (item._id.includes("success")) {
        status.Approved += item.count; // Mapping "Accepted" to "Approved" for frontend consistency
      } else if (item._id.includes("rejected")) {
        status.Rejected += item.count;
      } else {
        status.Pending += item.count; // For any other status, if present
      }
    });

    // Geographic Distribution
    const geoAgg = await collection.aggregate([
      { $match: { state: { $ne: null, $exists: true } } },
      { $group: { _id: "$state", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 }
    ]).toArray();
    const geographicDistribution = {};
    geoAgg.forEach(item => {
      geographicDistribution[item._id] = item.count;
    });

    // Recent Activity
    const recentActivity = await collection.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .toArray();
    const formattedActivity = recentActivity.map(item => ({
      name: item.name,
      model: item.model,
      city: item.city,
      state: item.state,
      dealer_details: item.dealer_details,
      reason: item.reason,
      status: item.reason.includes("success") ? "Approved" : "Rejected",
      time: new Date(item.createdAt).toLocaleString()
    }));

    res.json({
      totalLeads,
      modelDistribution,
      status,
      geographicDistribution,
      recentActivity: formattedActivity
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

//Visualize data acordingly week
routes.get('/api/lead-summary/:dataName', async (req, res) => {
  const dataName = req.params.dataName;
  const dateRange = req.query.dateRange || 'thisWeek';
 

  // Adjust for IST (UTC+5:30)
  const IST_OFFSET = 5.5 * 60 * 60000; // 5.5 hours in milliseconds

  const customStartDate = req.query.customStartDate
    ? new Date(new Date(req.query.customStartDate).getTime() - IST_OFFSET)
    : null;

  const customEndDate = req.query.customEndDate
    ? new Date(new Date(req.query.customEndDate).getTime() - IST_OFFSET + (23 * 60 + 59) * 60000 + 59000)
    : null;

  try {
    const db = await getDatabase(dataName);
    const collectionName = collectionNames[dataName];

    if (!collectionName) {
      return res.status(400).json({ status: "error", message: "No collection found for data name: " + dataName });
    }

    const collection = db.collection(collectionName);

    // Build date filter using IST
    const now = new Date();
    let filter = {};

    if (dateRange === 'today') {
      const istNow = new Date(now.getTime() - IST_OFFSET);
      const startOfDay = new Date(istNow.setHours(0, 0, 0, 0));
      const endOfDay = new Date(istNow.setHours(23, 59, 59, 999));
      filter['createdAt'] = { $gte: startOfDay, $lte: endOfDay };
    } else if (dateRange === 'thisWeek') {
      const istNow = new Date(now.getTime() - IST_OFFSET);
      const startOfWeek = new Date(istNow);
      const dayOfWeek = istNow.getDay();
      // Move to Monday: subtract (dayOfWeek - 1) days, where Monday is 1
      startOfWeek.setDate(istNow.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
      startOfWeek.setHours(0, 0, 0, 0);
      const endOfWeek = new Date(startOfWeek);
      endOfWeek.setDate(startOfWeek.getDate() + 6); // Sets to Sunday
      endOfWeek.setHours(23, 59, 59, 999);
      filter['createdAt'] = { $gte: startOfWeek, $lte: endOfWeek };
      
    } else if (dateRange === 'thisMonth') {
      const istNow = new Date(now.getTime() - IST_OFFSET);
      const startOfMonth = new Date(istNow.getFullYear(), istNow.getMonth(), 1);
      const endOfMonth = new Date(istNow.getFullYear(), istNow.getMonth() + 1, 0);
      endOfMonth.setHours(23, 59, 59, 999);
      filter['createdAt'] = { $gte: startOfMonth, $lte: endOfMonth };
    } else if (dateRange === 'custom' && customStartDate && customEndDate) {
      filter['createdAt'] = { $gte: customStartDate, $lte: customEndDate };
    } else {
      return res.status(400).json({ status: "error", message: "Invalid date range" });
    }

    // Aggregate leads by day, adjusted for IST
    const pipeline = [
      { $match: filter },
      {
        $group: {
          _id: {
            $dayOfWeek: {
              $dateAdd: {
                startDate: "$createdAt",
                unit: "millisecond",
                amount: IST_OFFSET // Add 5.5 hours to shift to IST
              }
            }
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { "_id": 1 } }
    ];

    const results = await collection.aggregate(pipeline).toArray();

    // Map results to Mon-Fri (skipping Sunday and Saturday)
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dailyCounts = new Array(7).fill(0);
    results.forEach(result => {
      const dayIndex = result._id - 1; // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
      if (dayIndex >= 0 && dayIndex < 7) dailyCounts[dayIndex] = result.count;
    });

    const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const orderedIndexes = [1, 2, 3, 4, 5, 6, 0]; // Mon to Sun
    const counts = orderedIndexes.map(index => dailyCounts[index]);

    const changes = calculatePercentageChanges(counts);

    res.json({
      status: "success",
      data: { labels, counts, changes },
      message: "Lead summary retrieved successfully"
    });
  } catch (error) {
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Helper function to calculate percentage changes
function calculatePercentageChanges(counts) {
  const changes = [];
  for (let i = 1; i < counts.length; i++) {
    const prev = counts[i - 1] || 1; // Avoid division by zero
    const curr = counts[i];
    changes.push(Math.round(((curr - prev) / prev) * 100));
  }
  changes.unshift(0); // First day has no change
  return changes;
}
//model 
routes.get("/model-popularity",async (req, res) => {
  try {
    const db = await getDatabase("skoda"); // Assuming Skoda data is in the "skoda" database
    const collection = db.collection(collectionNames.skoda);

    // Aggregation pipeline to count occurrences of each model
    const aggregationPipeline = [
      { $match: { "model": { $in: ["Kodiaq", "Kushaq", "Slavia"] } } },
      { $group: { _id: "$model", count: { $sum: 1 } } },
      { $project: { name: "$_id", value: "$count" } }
    ];

    const data = await collection.aggregate(aggregationPipeline).toArray();
    res.json(data);
  } catch (error) {
    res.status(500).send("Error fetching model popularity: " + error.message);
  }
});
//skoda leads over time
routes.get("/leads-over-time", async (req, res) => {
  try {
    const db = await getDatabase("skoda");
    const collection = db.collection(collectionNames.skoda);

    // Get query parameters
    const { dateRange, startDate, endDate } = req.query;
    console.log("DAte",dateRange, startDate, endDate);

    // Define date filters based on dateRange in IST
    let start, end;
    const now = moment().tz("Asia/Kolkata"); // Current time in IST

    if (dateRange === "today") {
      start = now.clone().startOf('day'); // 00:00:00 IST
      end = now.clone().endOf('day'); // 23:59:59 IST
    } else if (dateRange === "thisWeek") {
      start = now.clone().startOf('isoWeek'); // Monday 00:00:00 IST
      end = now.clone().endOf('isoWeek'); // Sunday 23:59:59 IST
    } else if (dateRange === "thisMonth") {
      start = now.clone().startOf('month'); // 1st of month 00:00:00 IST
      end = now.clone().endOf('month'); // Last day of month 23:59:59 IST
    } else if (dateRange === "custom" && startDate && endDate) {
      start = moment.tz(startDate, "YYYY-MM-DD", "Asia/Kolkata").startOf('day');
      end = moment.tz(endDate, "YYYY-MM-DD", "Asia/Kolkata").endOf('day');
    } else {
      return res.status(400).send("Invalid date range or missing custom dates");
    }

    // Convert IST dates to UTC for MongoDB query
    const startUTC = start.clone().utc().toDate();
    const endUTC = end.clone().utc().toDate();

    // Aggregation pipeline
    const aggregationPipeline = [
      {
        $match: {
          createdAt: {
            $gte: startUTC,
            $lte: endUTC,
          },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$createdAt",
              timezone: "Asia/Kolkata", // Group by IST date
            },
          },
          count: { $sum: 1 },
        },
      },
      {
        $sort: { _id: 1 }, // Sort by date ascending
      },
      {
        $project: {
          date: "$_id",
          count: 1,
          _id: 0,
        },
      },
    ];

    const data = await collection.aggregate(aggregationPipeline).toArray();
    res.json({ labels: data.map(d => d.date), counts: data.map(d => d.count) });
  } catch (error) {
    res.status(500).send("Error fetching leads over time: " + error.message);
  }
});
//loan leads over time
routes.get("/lead-over-time", async (req, res) => {
  try {
    const db = await getDatabase("loan");
    const collection = db.collection(collectionNames.loan);

    // Get query parameters
    const { dateRange, startDate, endDate } = req.query;
    console.log("DAte",dateRange, startDate, endDate);

    // Define date filters based on dateRange in IST
    let start, end;
    const now = moment().tz("Asia/Kolkata"); // Current time in IST

    if (dateRange === "today") {
      start = now.clone().startOf('day'); // 00:00:00 IST
      end = now.clone().endOf('day'); // 23:59:59 IST
    } else if (dateRange === "thisWeek") {
      start = now.clone().startOf('isoWeek'); // Monday 00:00:00 IST
      end = now.clone().endOf('isoWeek'); // Sunday 23:59:59 IST
    } else if (dateRange === "thisMonth") {
      start = now.clone().startOf('month'); // 1st of month 00:00:00 IST
      end = now.clone().endOf('month'); // Last day of month 23:59:59 IST
    } else if (dateRange === "custom" && startDate && endDate) {
      start = moment.tz(startDate, "YYYY-MM-DD", "Asia/Kolkata").startOf('day');
      end = moment.tz(endDate, "YYYY-MM-DD", "Asia/Kolkata").endOf('day');
    } else {
      return res.status(400).send("Invalid date range or missing custom dates");
    }

    // Convert IST dates to UTC for MongoDB query
    const startUTC = start.clone().utc().toDate();
    const endUTC = end.clone().utc().toDate();

    // Aggregation pipeline
    const aggregationPipeline = [
      {
        $match: {
          createdAt: {
            $gte: startUTC,
            $lte: endUTC,
          },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$createdAt",
              timezone: "Asia/Kolkata", // Group by IST date
            },
          },
          count: { $sum: 1 },
        },
      },
      {
        $sort: { _id: 1 }, // Sort by date ascending
      },
      {
        $project: {
          date: "$_id",
          count: 1,
          _id: 0,
        },
      },
    ];

    const data = await collection.aggregate(aggregationPipeline).toArray();
    res.json({ labels: data.map(d => d.date), counts: data.map(d => d.count) });
  } catch (error) {
    res.status(500).send("Error fetching leads over time: " + error.message);
  }
});

//loan credit distribution
routes.get('/api/credit-distribution/:dataName', async (req, res) => {
  const dataName = req.params.dataName;
  const { dateRange, startDate, endDate } = req.query;
  

  try {
    const db = await getDatabase(dataName);
    const collectionName = collectionNames[dataName];

    if (!collectionName) {
      return res.status(400).json({ status: "error", message: "No collection found for data name: " + dataName });
    }

    const collection = db.collection(collectionName);

    // Define date filters based on dateRange in IST
    let start, end;
    const now = moment().tz("Asia/Kolkata"); // Current time in IST

    if (dateRange === "today") {
      start = now.clone().startOf('day'); // 00:00:00 IST
      end = now.clone().endOf('day'); // 23:59:59 IST
    } else if (dateRange === "thisWeek") {
      start = now.clone().startOf('isoWeek'); // Monday 00:00:00 IST
      end = now.clone().endOf('isoWeek'); // Sunday 23:59:59 IST
    } else if (dateRange === "thisMonth") {
      start = now.clone().startOf('month'); // 1st of month 00:00:00 IST
      end = now.clone().endOf('month'); // Last day of month 23:59:59 IST
    } else if (dateRange === "custom" && startDate && endDate) {
      start = moment.tz(startDate, "YYYY-MM-DD", "Asia/Kolkata").startOf('day');
      end = moment.tz(endDate, "YYYY-MM-DD", "Asia/Kolkata").endOf('day');
    } else {
      return res.status(400).json({ status: "error", message: "Invalid date range or missing custom dates" });
    }

    // Convert IST dates to UTC for MongoDB query
    const startUTC = start.clone().utc().toDate();
    const endUTC = end.clone().utc().toDate();
   console.log(startUTC,endUTC)
    // Aggregation pipeline to group by credit score ranges
    const pipeline = [
      {
        $match: {
          'data.credit_score': { $gte: 300, $lte: 850 },
          createdAt: { $gte: startUTC, $lte: endUTC }
        }
      },
      {
        $bucket: {
          groupBy: '$data.credit_score',
          boundaries: [300, 501, 701, 851], // Ranges: 300-500, 501-700, 701-850
          default: 'Other',
          output: {
            count: { $sum: 1 }
          }
        }
      }
    ];

    const results = await collection.aggregate(pipeline).toArray();

    // Format results for Chart.js
    const labels = ['300-500', '501-700', '701-850'];
    const counts = new Array(3).fill(0);

    results.forEach(result => {
      const index = labels.indexOf(
        result._id === 300 ? '300-500' :
        result._id === 501 ? '501-700' :
        result._id === 701 ? '701-850' : null
      );
      if (index !== -1) {
        counts[index] = result.count;
      }
    });
   
    res.json({
      status: "success",
      data: { labels, counts },
      message: "Credit score distribution retrieved successfully"
    });
  } catch (error) {
    res.status(500).json({ status: "error", message: error.message });
  }
});

routes.get('/api/model-user-counts/:dataName', async (req, res) => {
  const dataName = req.params.dataName;
  const { dateRange, customStartDate, customEndDate } = req.query;

  // Adjust for IST (UTC+5:30)
  const IST_OFFSET = 5.5 * 60 * 60000; // 5.5 hours in milliseconds

  try {
    const db = await getDatabase(dataName);
    const collectionName = collectionNames[dataName];

    if (!collectionName) {
      return res.status(400).json({ status: "error", message: "No collection found for data name: " + dataName });
    }

    const collection = db.collection(collectionName);

    // Build date filter using IST
    const now = new Date();
    let startDate, endDate;

    if (dateRange === 'today') {
      const istNow = new Date(now.getTime() - IST_OFFSET);
      startDate = new Date(istNow.setHours(0, 0, 0, 0));
      endDate = new Date(istNow.setHours(23, 59, 59, 999));
    } else if (dateRange === 'thisWeek') {
      const istNow = new Date(now.getTime() - IST_OFFSET);
      const startOfWeek = new Date(istNow);
      const dayOfWeek = istNow.getDay();
      startOfWeek.setDate(istNow.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1)); // Move to Monday
      startOfWeek.setHours(0, 0, 0, 0);
      endDate = new Date(startOfWeek);
      endDate.setDate(startOfWeek.getDate() + 6); // Sunday
      endDate.setHours(23, 59, 59, 999);
      startDate = startOfWeek;
    } else if (dateRange === 'thisMonth') {
      const istNow = new Date(now.getTime() - IST_OFFSET);
      startDate = new Date(istNow.getFullYear(), istNow.getMonth(), 1);
      endDate = new Date(istNow.getFullYear(), istNow.getMonth() + 1, 0);
      endDate.setHours(23, 59, 59, 999);
    } else if (dateRange === 'custom' && customStartDate && customEndDate) {
      startDate = new Date(new Date(customStartDate).getTime() - IST_OFFSET);
      endDate = new Date(new Date(customEndDate).getTime() - IST_OFFSET + (23 * 60 + 59) * 60000 + 59000);
    } else {
      return res.status(400).json({ status: "error", message: "Invalid date range or missing custom dates" });
    }
    console.log("Start",startDate,endDate)

    // Aggregation pipeline to count users for specific models
    const pipeline = [
      {
        $match: {
          createdAt: { $gte: startDate, $lte: endDate },
          model: { $in: ['Kushaq', 'Slavia', 'Kodiaq'] }
        }
      },
      {
        $group: {
          _id: '$model',
          count: { $sum: 1 }
        }
      },
      {
        $sort: { _id: 1 }
      }
    ];

    const results = await collection.aggregate(pipeline).toArray();

    // Format results for Chart.js
    const labels = ['Kushaq', 'Slavia', 'Kodiaq'];
    const counts = new Array(3).fill(0);

    results.forEach(result => {
      const index = labels.indexOf(result._id);
      if (index !== -1) {
        counts[index] = result.count;
      }
    });
    console.log("data",labels,counts)
    res.json({
      status: "success",
      data: { labels, counts },
      message: "Model user counts retrieved successfully"
    });
  } catch (error) {
    res.status(500).json({ status: "error", message: error.message });
  }
});
  


module.exports = routes;

