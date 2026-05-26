import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import open from 'open';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const DEFAULT_PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve static assets from public folder
app.use(express.static(path.join(__dirname, 'public')));

// Helper to normalize and sanitize Reddit thread URL to public JSON feed
function normalizeRedditUrl(inputUrl) {
  try {
    let cleanUrl = inputUrl.trim();
    if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
      cleanUrl = 'https://' + cleanUrl;
    }
    
    const parsedUrl = new URL(cleanUrl);
    
    // Validate domain
    if (!parsedUrl.hostname.includes('reddit.com')) {
      throw new Error('Not a valid Reddit URL');
    }
    
    let pathname = parsedUrl.pathname;
    
    // Ensure trailing slash is removed before appending .json
    if (pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }
    
    // Append .json if not already present
    if (!pathname.endsWith('.json')) {
      pathname += '.json';
    }
    
    parsedUrl.pathname = pathname;
    
    // We force sorting by 'new' to get the latest comments immediately
    parsedUrl.searchParams.set('sort', 'new');
    
    // Remove unnecessary tracking parameters
    parsedUrl.searchParams.delete('utm_source');
    parsedUrl.searchParams.delete('utm_medium');
    parsedUrl.searchParams.delete('utm_name');
    
    return parsedUrl.toString();
  } catch (error) {
    throw new Error('Invalid Reddit URL format. Please provide a valid Reddit thread URL.');
  }
}

// Proxy endpoint to fetch comments
app.get('/api/comments', async (req, res) => {
  const threadUrl = req.query.url;
  
  if (!threadUrl) {
    return res.status(400).json({ error: 'Missing "url" query parameter.' });
  }
  
  try {
    const targetUrl = normalizeRedditUrl(threadUrl);
    console.log(`[Proxy] Fetching comments from Reddit: ${targetUrl}`);
    
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 reddit-whisper-app:v1.0.0 (by /u/antigravity)'
      }
    });
    
    if (!response.ok) {
      const errorMsg = `Reddit API responded with status: ${response.status} ${response.statusText}`;
      console.error(`[Error] ${errorMsg}`);
      return res.status(response.status).json({ error: errorMsg });
    }
    
    const data = await response.json();
    
    // Reddit comment feed is returning an array of two Listings:
    // data[0] contains the post itself
    // data[1] contains the comments tree
    if (!Array.isArray(data) || data.length < 2) {
      return res.status(422).json({ error: 'Unexpected JSON response structure from Reddit.' });
    }
    
    const commentsListing = data[1];
    if (!commentsListing.data || !Array.isArray(commentsListing.data.children)) {
      return res.status(422).json({ error: 'Unable to parse comments tree from Reddit data.' });
    }
    
    // Extract and clean comments
    const comments = commentsListing.data.children
      .filter(child => child.kind === 't1' && child.data) // t1 refers to comments
      .map(child => {
        const d = child.data;
        return {
          id: d.id,
          author: d.author || '[deleted]',
          body: d.body || '[no content]',
          score: d.score ?? 0,
          created_utc: d.created_utc || Math.floor(Date.now() / 1000),
          permalink: d.permalink ? `https://reddit.com${d.permalink}` : null
        };
      });
      
    console.log(`[Proxy] Successfully parsed ${comments.length} comments.`);
    return res.json({ comments });
    
  } catch (error) {
    console.error('[Proxy Error]', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// Start Express server on available port
function startServer(port) {
  app.listen(port, () => {
    const localUrl = `http://localhost:${port}`;
    console.log(`==================================================`);
    console.log(`🚀 Reddit Whisper is running at: ${localUrl}`);
    console.log(`==================================================`);
    
    // Open in browser
    open(localUrl).catch(err => {
      console.warn(`[Warning] Could not automatically open browser: ${err.message}`);
    });
  }).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`⚠️  Port ${port} is in use, trying port ${port + 1}...`);
      startServer(port + 1);
    } else {
      console.error('[Server Error]', err);
    }
  });
}

startServer(DEFAULT_PORT);
