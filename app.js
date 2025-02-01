require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");

const app = express();
const port = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Konfigurasi koneksi ke Supabase PostgreSQL
const pool = new Pool({
  host: process.env.SUPABASE_HOST,
  database: process.env.SUPABASE_DATABASE,
  user: process.env.SUPABASE_USER,
  password: process.env.SUPABASE_PASSWORD,
  port: process.env.SUPABASE_PORT,
  ssl: { rejectUnauthorized: false }, // Supabase memerlukan SSL
});

// Endpoint untuk mendapatkan data dari tabel
app.get("/komisi", async (req, res) => {
  try {
    const result = await pool.query(`
        SELECT 
            m.id AS marketing_id,
            m.name AS marketing_name,
            TO_CHAR(DATE_TRUNC('month', p.date), 'FMMonth') AS bulan,
            SUM(p.grand_total) AS omzet,
            CASE 
                WHEN SUM(p.grand_total) >= 500000000 THEN 10
                WHEN SUM(p.grand_total) >= 200000000 THEN 5
                WHEN SUM(p.grand_total) >= 100000000 THEN 2.5
                ELSE 0
            END AS komisi_persen,
            CASE 
                WHEN SUM(p.grand_total) < 100000000 THEN 0
                WHEN SUM(p.grand_total) >= 100000000 AND SUM(p.grand_total) < 200000000 THEN SUM(p.grand_total) * 0.025
                WHEN SUM(p.grand_total) >= 200000000 AND SUM(p.grand_total) < 500000000 THEN SUM(p.grand_total) * 0.05
                ELSE SUM(p.grand_total) * 0.1
            END AS komisi
        FROM marketing m
        JOIN penjualan p ON m.id = p.marketing_id
        GROUP BY m.id, m.name, DATE_TRUNC('month', p.date)
        ORDER BY m.id, bulan;
            `);

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Terjadi kesalahan pada server" });
  }
});

app.post("/pembayaran", async (req, res) => {
  const { marketing_id, amount_paid, transaction_number } = req.body;

  try {
    if (!Number.isInteger(amount_paid) || amount_paid <= 0) {
      return res
        .status(400)
        .json({ error: "amount_paid harus bilangan bulat positif" });
    }

    // Ambil omzet bulan ini untuk marketing_id
    const omzetResult = await pool.query(
      "SELECT COALESCE(SUM(amount_paid), 0) AS omzet FROM pembayaran WHERE marketing_id = $1 AND payment_date >= date_trunc('month', CURRENT_DATE)",
      [marketing_id]
    );
    const omzet = parseInt(omzetResult.rows[0].omzet, 10);

    // Target komisi adalah 5 juta
    const targetKomisi = 5000000;

    // Jika omzet sudah mencapai target komisi, tidak perlu pembayaran
    if (omzet >= targetKomisi) {
      return res
        .status(400)
        .json({
          error: "Omzet sudah mencapai target komisi, tidak perlu pembayaran",
        });
    }

    // Hitung remaining_balance
    let remaining_balance = targetKomisi - omzet;

    // Validasi jika pembayaran lebih besar dari remaining_balance
    if (amount_paid > remaining_balance) {
      return res
        .status(400)
        .json({
          error:
            "Pembayaran melebihi sisa yang dibutuhkan untuk mencapai komisi",
        });
    }

    let new_balance = remaining_balance - amount_paid;
    let status = new_balance > 0 ? "Cicilan" : "Lunas";

    // Simpan pembayaran
    await pool.query(
      "INSERT INTO pembayaran (marketing_id, amount_paid, remaining_balance, status) VALUES ($1, $2, $3, $4)",
      [marketing_id, amount_paid, new_balance, status]
    );

    res.json({
      message: "Pembayaran berhasil ditambahkan",
      remaining_balance: new_balance,
      target_komisi: targetKomisi,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Terjadi kesalahan server" });
  }
});

app.get("/pembayaran", async (req, res) => {
  try {
    const result = await pool.query(`SELECT 
                CONCAT(TO_CHAR(DATE_TRUNC('month', p.payment_date), 'YYYY'), ' - ', TO_CHAR(DATE_TRUNC('month', p.payment_date), 'FMMonth')) AS bulan,
                SUM(amount_paid) AS total_amount_paid,
                CASE 
                    WHEN SUM(amount_paid) >= p.remaining_balance THEN 'Lunas'
                    ELSE 'Kredit / Belum Lunas'
                END AS status,
                m.name,
                p.marketing_id
            FROM 
                pembayaran p
            LEFT JOIN 
                marketing m ON p.marketing_id = m.id
            GROUP BY 
                DATE_TRUNC('month', p.payment_date), 
                m.name,
                p.remaining_balance,
                p.marketing_id`);
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Terjadi kesalahan server" });
  }
});

app.get("/pembayaran/:marketing_id/:payment_date", async (req, res) => {
  const { marketing_id, payment_date } = req.params; // Extract both parameters from the route

  try {
    // Construct the SQL query to group by year-month and check the condition for "Lunas" or "Kredit"
    let query = `
        SELECT 
            CONCAT(TO_CHAR(DATE_TRUNC('month', p.payment_date), 'YYYY'), ' - ', TO_CHAR(DATE_TRUNC('month', p.payment_date), 'FMMonth')) AS bulan,
            SUM(amount_paid) AS total_amount_paid,
            CASE 
                WHEN SUM(amount_paid) >= p.remaining_balance THEN 'Lunas'
                ELSE 'Kredit / Belum Lunas'
            END AS status,
            m.name,
            p.marketing_id
        FROM 
            pembayaran p
        LEFT JOIN 
            marketing m ON p.marketing_id = m.id
            WHERE 
            m.id = $1
        AND TO_CHAR(p.payment_date, 'YYYY-MM') = $2
        GROUP BY 
            DATE_TRUNC('month', p.payment_date), 
            m.name,
            p.remaining_balance,
            p.marketing_id;
      `;

    const result = await pool.query(query, [marketing_id, payment_date]);

    // Check if no records are found
    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({
          error: "Tidak ada pembayaran untuk marketing ini pada bulan tersebut",
        });
    }

    // Send the result as JSON
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Terjadi kesalahan server" });
  }
});

app.get("/marketing", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM marketing");
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Terjadi kesalahan server" });
  }
});

// Menjalankan server
app.listen(port, () => {
  console.log(`Server berjalan di http://localhost:${port}`);
});
