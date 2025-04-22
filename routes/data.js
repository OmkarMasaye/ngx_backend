const express = require('express');
const { MongoClient } = require('mongodb');
const { parse } = require('json2csv');
const routes = express.Router();
const {authenticateToken} = require('./jwt'); 
const moment = require('moment-timezone');

const skodaDbUrl = "mongodb://localhost:27017/skoda"; 
const tataDbUrl = "mongodb://localhost:27017/skoda"; 
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

routes.get("/viewdata/:dataName", authenticateToken, async (req, res) => {
  const dataName = req.params.dataName;
  const format = req.query.format || "json";
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip = (page - 1) * limit;
  const sortBy = req.query.sortBy || 'createdAt';
  const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;

  const name = req.query.name ? req.query.name.trim() : '';
  const email = req.query.email ? req.query.email.trim() : '';
  const mobile = req.query.mobile ? req.query.mobile.trim() : ''; // Treat mobile as a string
  const app_id = req.query.app_id ? req.query.app_id.trim() : ''; // Treat app_id as a string

  const dateRange = req.query.dateRange;
  const customStart = req.query.customStartDate ? new Date(Date.parse(req.query.customStartDate + 'T00:00:00Z')) : null;
  const customEnd = req.query.customEndDate ? new Date(Date.parse(req.query.customEndDate + 'T23:59:59Z')) : null;

  try {
    const db = await getDatabase(dataName);
    const collectionName = collectionNames[dataName];

    if (!collectionName) {
      throw new Error("No collection found for data name: " + dataName);
    }

    const collection = db.collection(collectionName);

    const filter = {};
    if (name) filter['name'] = { $regex: name, $options: 'i' };
    if (email) filter['email'] = { $regex: email, $options: 'i' };

    // Use aggregation to convert mobile and app_id to string and then apply regex for partial matching
    const aggregationPipeline = [
      { $match: filter },
      { $addFields: {
        mobileStr: { $toString: "$mobile" },  // Convert mobile to string
        appIdStr: { $toString: "$app_id" }    // Convert app_id to string
      }}
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
      filter['createdAt'] = { $gte: startOfDay, $lt: endOfDay };
    } else if (dateRange === 'thisWeek') {
      const startOfWeek = new Date(now);
      startOfWeek.setDate(now.getDate() - now.getDay());
      startOfWeek.setHours(0, 0, 0, 0);
      const endOfWeek = new Date(startOfWeek);
      endOfWeek.setDate(startOfWeek.getDate() + 6);
      endOfWeek.setHours(23, 59, 59, 999);
      filter['createdAt'] = { $gte: startOfWeek, $lt: endOfWeek };
    } else if (dateRange === 'thisMonth') {
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      endOfMonth.setHours(23, 59, 59, 999);
      filter['createdAt'] = { $gte: startOfMonth, $lt: endOfMonth };
    } else if (dateRange === 'custom' && customStart && customEnd) {
      filter['createdAt'] = { $gte: customStart, $lte: customEnd };
    }

    // Push the limit, skip, and sort to the aggregation pipeline
    aggregationPipeline.push({ $sort: { [sortBy]: sortOrder } });

    // Determine if we should apply pagination based on format
    if (format !== "csv") {
      aggregationPipeline.push({ $skip: skip }, { $limit: limit });
    }

    // Execute query
    let data = await collection.aggregate(aggregationPipeline).toArray();
    let totalRecords = await collection.countDocuments(filter); // count without pagination

    const totalPages = Math.ceil(totalRecords / limit);

    const responseData = {
      data,
      totalRecords,
      totalPages,
      currentPage: page,
    };

    if (format === "csv") {
      try {
        const csv = parse(data);
        res.header("Content-Type", "text/csv");
        res.attachment(`${dataName}.csv`);
        res.send(csv);
      } catch (err) {
        res.status(500).send("Error generating CSV");
      }
    } else {
      res.json(responseData);
    }
  } catch (error) {
    res.status(500).send("Error fetching data: " + error.message);
  }
});

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
  
routes.get('/api/loan/geographical-distribution', async (req, res) => {
  try {
    const { db, client } = await getDatabase('loan');
    const collection = db.collection(collectionNames.loan);

    // Aggregate leads by comm_city and comm_state
    const aggregation = [
      {
        $group: {
          _id: {
            city: "$d.comm_city",
            state: "$d.comm_state",
            pincode: "$d.comm_pincode",
          },
          count: { $sum: 1 },
        },
      },
      {
        $project: {
          city: "$_id.city",
          state: "$_id.state",
          pincode: "$_id.pincode",
          count: 1,
          _id: 0,
        },
      },
    ];

    const results = await collection.aggregate(aggregation).toArray();

    // Mock coordinates for cities (replace with real geocoding API in production)
    const cityCoordinates = {
      Etawah: { lat: 26.7767, lng: 79.0218 },
      // Add more cities as needed
    };

    const geoData = results.map(result => ({
      city: result.city || 'Unknown',
      state: result.state || 'Unknown',
      pincode: result.pincode || 'Unknown',
      count: result.count,
      lat: cityCoordinates[result.city]?.lat || 20.5937, // Default to India center
      lng: cityCoordinates[result.city]?.lng || 78.9629,
    }));

    await client.close();
    res.json(geoData);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = routes;

