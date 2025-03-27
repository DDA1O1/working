import express from 'express';
import { WebSocketServer } from 'ws';
import { spawn } from 'child_process'; 
import dgram from 'dgram'; 
import { fileURLToPath } from 'url'; 
import { dirname, join } from 'path'; 
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Unified error handling system
const ErrorTypes = {
    COMMAND: 'COMMAND_ERROR',
    STREAM: 'STREAM_ERROR',
    PROCESS: 'PROCESS_ERROR',
    FILE: 'FILE_ERROR',
    NETWORK: 'NETWORK_ERROR'
};

function handleError(type, error, res = null) {
    // Log the error with context
    console.error(`[${type}] ${error.message || error}`);
    
    // If response object exists, send appropriate error response
    if (res) {
        const statusCodes = {
            [ErrorTypes.COMMAND]: 400,
            [ErrorTypes.STREAM]: 503,
            [ErrorTypes.PROCESS]: 500,
            [ErrorTypes.FILE]: 500,
            [ErrorTypes.NETWORK]: 503
        };
        
        const messages = {
            [ErrorTypes.COMMAND]: 'Failed to execute drone command',
            [ErrorTypes.STREAM]: 'Video stream error',
            [ErrorTypes.PROCESS]: 'Internal process error',
            [ErrorTypes.FILE]: 'File operation failed',
            [ErrorTypes.NETWORK]: 'Network communication error'
        };
        
        res.status(statusCodes[type] || 500)
           .send(messages[type] + ': ' + (error.message || error));
    }
    
    return false;
}

// Create separate folders for different media types
const createMediaFolders = () => {
    // First creates the main uploads folder
    const uploadsDir = join(__dirname, 'uploads');
    
    // Then creates two subfolders inside uploads:
    const photosDir = join(uploadsDir, 'photos');        // for photos
    const mp4Dir = join(uploadsDir, 'mp4_recordings');   // for .mp4 files

    // Creates all folders if they don't exist
    [uploadsDir, photosDir, mp4Dir].forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true }); // recursive: true allows creating nested directories
        }
    });

    return { uploadsDir, photosDir, mp4Dir };
};

// Initialize folders
const { photosDir, mp4Dir } = createMediaFolders();

// Initialize Express app
const app = express();
const port = 3000;
const streamPort = 3001;

// Configure middleware for parsing JSON and form data
app.use(express.json());  // Default ~100kb limit is sufficient
app.use(express.urlencoded({ extended: true }));  // Default limit for form data

// Tello drone configuration
const TELLO_IP = '192.168.10.1';
const TELLO_PORT = 8889;
const TELLO_VIDEO_PORT = 11111;

// Create UDP client for drone commands
const droneClient = dgram.createSocket('udp4');

// Create WebSocket server
const wss = new WebSocketServer({ 
    port: streamPort,
    clientTracking: true  // Enable basic client tracking
});

const clients = new Set(); // Set to store active clients
let nextClientId = 0;     // Counter for client IDs

// Add WebSocket server event handlers
wss.on('listening', () => {
    console.log(`WebSocket server is listening on port ${streamPort}`);
});

wss.on('error', (error) => {
    console.error('WebSocket server error:', error);
});

wss.on('connection', (ws, req) => {
    try {
        // Assign client ID and add to tracked clients
        ws.clientId = nextClientId++;
        clients.add(ws);
        
        console.log(`New client ${ws.clientId} connected`);
        console.log(`Total connected clients: ${clients.size}`);

        // Handle disconnection
        ws.on('close', () => {
            console.log(`Client ${ws.clientId} disconnected`);
            clients.delete(ws);
            console.log(`Remaining clients: ${clients.size}`);
        });

        // Handle errors
        ws.on('error', (error) => {
            console.error(`Client ${ws.clientId} error:`, error);
            clients.delete(ws);
        });

    } catch (error) {
        console.error('Error in WebSocket connection handler:', error);
        ws.close(1011, 'Internal Server Error');
    }
});

// Handle drone responses
droneClient.on('message', (msg) => {
    const response = msg.toString();
    
    // Parse specific command responses
    if (!isNaN(response)) {
        if (lastCommand === 'battery?') {
            clients.forEach(client => {
                if (client.readyState === 1) {
                    client.send(JSON.stringify({
                        type: 'battery',
                        value: parseInt(response)
                    }));
                }
            });
        } else if (lastCommand === 'time?') {
            clients.forEach(client => {
                if (client.readyState === 1) {
                    client.send(JSON.stringify({
                        type: 'flightTime',
                        value: parseInt(response)
                    }));
                }
            });
        } else if (lastCommand === 'speed?') {
            clients.forEach(client => {
                if (client.readyState === 1) {
                    client.send(JSON.stringify({
                        type: 'speed',
                        value: parseInt(response)
                    }));
                }
            });
        }
    }
    
    console.log('Drone response:', response);
});

// Track last command sent
let lastCommand = '';

// Track monitoring intervals
let monitoringIntervals = [];

// Start periodic state monitoring
function startDroneMonitoring() {
    // Clear any existing intervals first
    stopDroneMonitoring();
    
    // Check battery every 10 seconds
    monitoringIntervals.push(setInterval(() => {
        droneClient.send('battery?', 0, 'battery?'.length, TELLO_PORT, TELLO_IP);
    }, 10000));

    // Check flight time every 5 seconds
    monitoringIntervals.push(setInterval(() => {
        droneClient.send('time?', 0, 'time?'.length, TELLO_PORT, TELLO_IP);
    }, 5000));

    // Check speed every 2 seconds
    monitoringIntervals.push(setInterval(() => {
        droneClient.send('speed?', 0, 'speed?'.length, TELLO_PORT, TELLO_IP);
    }, 2000));
}

// Stop all monitoring intervals
function stopDroneMonitoring() {
    monitoringIntervals.forEach(interval => clearInterval(interval));
    monitoringIntervals = [];
}

// Add a flag to track if streaming is active
let isStreamingActive = false;

// Add route for drone commands
app.get('/drone/:command', (req, res) => {
    try {
        const command = req.params.command;
        lastCommand = command;
        
        if (command === 'streamon') {
            droneClient.send(command, 0, command.length, TELLO_PORT, TELLO_IP, (err) => {
                if (err) return handleError(ErrorTypes.COMMAND, err, res);
                
                try {
                    // Start FFmpeg if not already running
                    if (!ffmpegProcess) {
                        startFFmpeg();
                    }
                    isStreamingActive = true;
                    res.send('Command sent');
                } catch (error) {
                    return handleError(ErrorTypes.PROCESS, 'Error starting video stream', res);
                }
            });
        } else if (command === 'streamoff') {
            droneClient.send(command, 0, command.length, TELLO_PORT, TELLO_IP, (err) => {
                if (err) return handleError(ErrorTypes.COMMAND, err, res);
                
                isStreamingActive = false;
                res.send('Stream paused');
            });
        } else if (command === 'command') {
            droneClient.send(command, 0, command.length, TELLO_PORT, TELLO_IP, (err) => {
                if (err) return handleError(ErrorTypes.COMMAND, err, res);
                
                startDroneMonitoring();
                res.send('Command sent');
            });
        } else {
            // Send other commands normally
            droneClient.send(command, 0, command.length, TELLO_PORT, TELLO_IP, (err) => {
                if (err) return handleError(ErrorTypes.COMMAND, err, res);
                res.send('Command sent');
            });
        }
    } catch (error) {
        return handleError(ErrorTypes.PROCESS, error, res);
    }
});


// Add global variable for photo capture
let captureRequested = false;

// Start FFmpeg process for video streaming
function startFFmpeg() {
    console.log('Starting FFmpeg process...');
    
    // Only start if no existing process
    if (ffmpegProcess) {
        console.log('FFmpeg process already running');
        return ffmpegProcess;
    }

    const ffmpeg = spawn('ffmpeg', [
        '-hide_banner',
        '-loglevel', 'warning',  // Changed from 'error' to 'warning' to catch important messages
        
        // Input configuration with larger buffer
        '-i', `udp://0.0.0.0:${TELLO_VIDEO_PORT}?overrun_nonfatal=1&fifo_size=50000000`,
        
        // First output: Stream for JSMpeg
        '-c:v', 'mpeg1video',      // Convert to mpeg1video for JSMpeg
        '-b:v', '800k',            // Video bitrate
        '-r', '30',                // Frame rate
        '-f', 'mpegts',           // MPEG-TS format required by JSMpeg
        '-flush_packets', '1',
        'pipe:1',
        
        // Second output: High-quality JPEG frames
        '-c:v', 'mjpeg',
        '-q:v', '2',              // High quality (1-31, lower is better)
        '-vf', 'fps=2',           // Limit frame updates (2 fps is enough for snapshots)
        '-update', '1',           // Update the same file
        '-f', 'image2',
        join(photosDir, 'current_frame.jpg')
    ]);

    ffmpegProcess = ffmpeg;

    let streamBuffer = Buffer.alloc(0); // Buffer to store video data
    const MPEGTS_PACKET_SIZE = 188; // MPEG-TS packet size
    const PACKETS_PER_CHUNK = 21; // Send ~4KB (21 * 188 = 3948 bytes)
    const CHUNK_SIZE = MPEGTS_PACKET_SIZE * PACKETS_PER_CHUNK;

    // Only log actual errors from stderr
    ffmpeg.stderr.on('data', (data) => {
        const message = data.toString().trim();
        if (message && !message.includes('Last message repeated')) {
            // Only log if it contains specific error keywords
            if (message.toLowerCase().includes('error') || 
                message.toLowerCase().includes('failed') ||
                message.toLowerCase().includes('unable to')) {
                console.error('FFmpeg Error:', message);
            }
        }
    });

    // Handle fatal errors with recovery
    ffmpeg.on('error', (error) => {
        console.error('FFmpeg fatal error:', error);
        // Only clear the reference if the process actually died
        if (ffmpegProcess === ffmpeg) {
            ffmpegProcess = null;
        }
        // Attempt to restart after a delay if streaming is still active
        if (isStreamingActive) {
            setTimeout(startFFmpeg, 1000);
        }
    });

    // Handle process exit with recovery
    ffmpeg.on('exit', (code, signal) => {
        if (code !== 0) {  // Only log non-zero exit codes (errors)
            console.error(`FFmpeg process exited with code ${code}, signal: ${signal}`);
            // Only clear the reference if the process actually died
            if (ffmpegProcess === ffmpeg) {
                ffmpegProcess = null;
            }
            // Attempt to restart after a delay if streaming is still active
            if (isStreamingActive) {
                setTimeout(startFFmpeg, 1000);
            }
        } else {
            console.log('FFmpeg process closed normally');
            if (ffmpegProcess === ffmpeg) {
                ffmpegProcess = null;
            }
        }
    });

    ffmpeg.stdout.on('data', (data) => {
        try {
            // Only process video data if streaming is active
            if (!isStreamingActive) return;
            
            // Combine new data with existing buffer
            streamBuffer = Buffer.concat([streamBuffer, data]);
            
            // While we have enough packets to make a chunk
            while (streamBuffer.length >= CHUNK_SIZE) {
                try {
                    // Take complete packets
                    const chunk = streamBuffer.subarray(0, CHUNK_SIZE);
                    
                    // Keep remaining bytes
                    streamBuffer = streamBuffer.subarray(CHUNK_SIZE);
                    
                    // Send to each connected client
                    clients.forEach((client) => {
                        if (client.readyState === 1) {
                            try {
                                client.send(chunk, { binary: true });
                            } catch (err) {
                                console.error(`Error sending chunk to client ${client.clientId}:`, err);
                                clients.delete(client);
                            }
                        }
                    });
                    
                    // Only write to MP4 if we're actively recording and have a valid process
                    if (isRecording && mp4Process && mp4Process.stdin.writable) {
                        try {
                            mp4Process.stdin.write(chunk);
                        } catch (error) {
                            console.error('Error writing to MP4 stream:', error);
                            // If we encounter an error writing, stop the recording
                            isRecording = false;
                            if (mp4Process) {
                                mp4Process.stdin.end();
                                mp4Process = null;
                                mp4FilePath = null;
                            }
                        }
                    }
                } catch (error) {
                    console.error('Error processing video chunk:', error);
                    streamBuffer = Buffer.alloc(0);
                }
            }
        } catch (error) {
            console.error('Error in FFmpeg data handler:', error);
            streamBuffer = Buffer.alloc(0);
        }
    });

    return ffmpeg; // Return the FFmpeg instance
}

// Modify photo capture endpoint
app.post('/capture-photo', async (req, res) => {
    if (!ffmpegProcess) {
        return handleError(ErrorTypes.STREAM, 'Video stream not active', res);
    }

    try {
        const timestamp = Date.now();
        const finalPhotoPath = join(photosDir, `photo_${timestamp}.jpg`);
        const currentFramePath = join(photosDir, 'current_frame.jpg');

        // Check if current frame exists
        try {
            await fs.promises.access(currentFramePath, fs.constants.F_OK);
        } catch (err) {
            return handleError(ErrorTypes.FILE, 'No frame available for capture', res);
        }

        // Check if current frame is being written to
        const maxRetries = 3;
        let retries = 0;
        while (retries < maxRetries) {
            try {
                // Try to copy the file
                await fs.promises.copyFile(currentFramePath, finalPhotoPath);
                
                // Verify the copied file exists and has size > 0
                const stats = await fs.promises.stat(finalPhotoPath);
                if (stats.size > 0) {
                    return res.json({ 
                        fileName: `photo_${timestamp}.jpg`,
                        size: stats.size,
                        timestamp: timestamp
                    });
                }
                throw new Error('Captured file is empty');
            } catch (err) {
                retries++;
                if (retries >= maxRetries) {
                    return handleError(ErrorTypes.FILE, 'Failed to capture valid photo after multiple attempts', res);
                }
                // Wait 100ms before next retry
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
    } catch (error) {
        return handleError(ErrorTypes.PROCESS, error, res);
    }
});

// Add global variable for mp4 process state
let mp4Process = null;
let mp4FilePath = null;
let isRecording = false;

// Function to initialize MP4 process
function initializeMP4Process() {
    console.log('Starting MP4 process...');
    
    // Only start if no existing process
    if (mp4Process) {
        console.log('MP4 process already running');
        return mp4Process;
    }

    const timestamp = Date.now();
    const mp4FileName = `video_${timestamp}.mp4`;
    mp4FilePath = join(mp4Dir, mp4FileName);
    
    try {
        // Set up the mp4 conversion process
        mp4Process = spawn('ffmpeg', [
            '-i', 'pipe:0',
            '-c:v', 'copy',
            '-c:a', 'copy',
            '-bsf:a', 'aac_adtstoasc',
            '-movflags', '+faststart',
            '-y',
            mp4FilePath
        ]);

        // Add error handlers
        mp4Process.stderr.on('data', (data) => {
            console.log('FFmpeg MP4:', data.toString());
        });

        mp4Process.on('error', (err) => {
            console.error('FFmpeg MP4 error:', err);
            mp4Process = null;
            mp4FilePath = null;
        });

        mp4Process.on('exit', (code, signal) => {
            if (code !== 0) {
                console.error(`MP4 process exited with code ${code}, signal: ${signal}`);
            }
            mp4Process = null;
            mp4FilePath = null;
        });

        return mp4Process;
    } catch (error) {
        console.error('Error initializing MP4 process:', error);
        mp4Process = null;
        mp4FilePath = null;
        return null;
    }
}

// Add route for saving video chunks
app.post('/start-recording', (req, res) => {
    // Check if recording is already in progress
    if (isRecording) {
        return res.status(409).send('Recording already in progress');
    }

    try {
        // Initialize MP4 process if not already running
        if (!mp4Process) {
            initializeMP4Process();
        }

        // Check if process initialized successfully
        if (!mp4Process || !mp4Process.stdin.writable) {
            throw new Error('Failed to initialize MP4 process');
        }

        // Set recording state to true
        isRecording = true;

        res.json({ mp4FileName: path.basename(mp4FilePath) });
        
    } catch (error) {
        console.error('Error starting recording:', error);
        res.status(500).send('Failed to start recording');
    }
});

app.post('/stop-recording', (req, res) => {
    if (!isRecording) {
        return res.status(400).send('No active recording');
    }

    try {
        // Set recording state to false first
        isRecording = false;
        
        // Clean up the MP4 process
        if (mp4Process) {
            // End the input stream
            mp4Process.stdin.end();
            
            // Kill the process after a short delay to allow it to finish writing
            setTimeout(() => {
                if (mp4Process) {
                    mp4Process.kill();
                    console.log('MP4 process killed');
                }
            }, 1000); // Give it 1 second to finish writing
            
            // Clear references after process exits
            mp4Process.on('exit', () => {
                console.log('MP4 process cleaned up successfully');
                mp4Process = null;
                mp4FilePath = null;
            });
        }
        
        res.send('Recording stopped');
    } catch (err) {
        console.error('Error stopping recording:', err);
        res.status(500).send('Error stopping recording');
    }
});

// Global variable act as a single source of truth for FFmpeg process
// This allows us to kill the old process before starting a new one multiple times before reaching the return statement
// would not have been possible if we used the return statement from startFFmpeg
let ffmpegProcess = null;

// Add this improved graceful shutdown handler
const gracefulShutdown = async () => {
    console.log('Starting graceful shutdown...');
    
    // Stop monitoring first
    stopDroneMonitoring();
    
    // 1. Stop accepting new connections
    wss.close(() => {
        console.log('WebSocket server closed');
    });

    // 2. Close all client connections
    clients.forEach(client => {
        try {
            client.close();
        } catch (err) {
            console.error('Error closing client:', err);
        }
    });

    // 3. Send emergency stop to drone
    try {
        await new Promise((resolve) => {
            droneClient.send('emergency', 0, 'emergency'.length, TELLO_PORT, TELLO_IP, () => {
                resolve();
            });
        });
    } catch (err) {
        console.error('Error sending emergency command:', err);
    }

    // 4. Close UDP socket
    droneClient.close();

    // 5. Kill FFmpeg processes
    if (ffmpegProcess) {
        ffmpegProcess.kill();
    }
    if (mp4Process) {
        mp4Process.stdin.end();
        mp4Process.kill();
    }

    // 6. Close any open file streams
    if (mp4Process) {
        await new Promise(resolve => mp4Process.stdin.end(resolve));
    }

    console.log('Graceful shutdown completed');
    process.exit(0);
};

// Handle different termination signals
['SIGINT', 'SIGTERM', 'SIGQUIT'].forEach(signal => {
    process.on(signal, gracefulShutdown);
});

// Serve static files
app.use(express.static(join(__dirname, 'dist')));

// Start servers sequentially
const startServers = async () => {
    try {
        // Start Express server first
        await new Promise((resolve) => {
            app.listen(port, () => {
                console.log(`Express server running on http://localhost:${port}`);
                resolve();
            });
        });

        // Verify WebSocket server is running
        if (wss.readyState !== wss.OPEN) {
            console.log('Waiting for WebSocket server to be ready...');
            await new Promise((resolve) => {
                wss.once('listening', resolve);
            });
        }
        
        console.log('Both servers are running');
        
    } catch (error) {
        console.error('Error starting servers:', error);
        process.exit(1);
    }
};

startServers(); 