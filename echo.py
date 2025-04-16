import asyncio
import json
import sys
import time
import traceback
import os
from typing import Dict, Optional

# Force unbuffered mode for all stdio operations
# This is critical for subprocess communication
os.environ['PYTHONUNBUFFERED'] = '1'

class EchoStdioServer:
    def __init__(self):
        self.model_configs: Dict[str, dict] = {
            "echo-test": {
                "max_tokens": 100,
                "temperature": 0.7
            }
        }
        self.request_count = 0
        print("EchoStdioServer initialized", file=sys.stderr, flush=True)
        
        # CRITICAL: Send immediate startup message to stdout
        # This confirms the process is alive and communication is working
        startup_message = {
            "type": "startup",
            "status": "ready",
            "models": list(self.model_configs.keys()),
            "time": time.time()
        }
        sys.stdout.write(json.dumps(startup_message) + '\n')
        sys.stdout.flush()
        print("Sent startup message to stdout", file=sys.stderr, flush=True)

    async def handle_request(self, request: dict) -> dict:
        self.request_count += 1
        request_id = request.get('id', None) # Capture request ID if present
        response_base = {"id": request_id} if request_id else {}
        
        # Debug log all incoming requests
        print(f"Handling request #{self.request_count}: {json.dumps(request)}", file=sys.stderr, flush=True)

        # Handle ping requests - special fast path for quick_response option
        if request.get('text') == 'ping' or (request.get('type') == 'ping') or (request.get('options', {}).get('quick_response') and request.get('text')):
            print(f"Received ping request with ID: {request_id}", file=sys.stderr, flush=True)
            return {
                **response_base,
                "text": "pong",
                "model": request.get('model', 'echo-test'),
                "type": "ping_response"
            }

        # Handle health check requests
        if request.get('type') == 'check':
            print(f"Received health check request with ID: {request_id}", file=sys.stderr, flush=True)
            return {**response_base, "type": "response", "status": "healthy"}

        # Handle normal echo requests
        text = request.get('text', '')
        model = request.get('model', 'echo-test')
        # Options are not used in this simple echo, but good practice
        # options = request.get('options', {})

        print(f"Processing echo request: '{text}'", file=sys.stderr, flush=True)
        
        response = {
            **response_base, # Include the original request ID in the response
            "text": f"Echo from {model}: {text}",
            "model": model,
            "usage": {
                "promptTokens": len(text.split()),
                "completionTokens": len(text.split()),
                "totalTokens": len(text.split()) * 2
            }
        }
        return response

    async def process_stdin(self):
        """Reads requests from stdin using run_in_executor and writes responses to stdout."""
        loop = asyncio.get_running_loop() # Get the current running loop
        print("Starting stdin processing using run_in_executor.", file=sys.stderr, flush=True) # Debug log

        while True:
            line = None # Initialize line for error logging
            try:
                # Run the blocking sys.stdin.readline in the default ThreadPoolExecutor
                print("Waiting for stdin input...", file=sys.stderr, flush=True)
                line_bytes_str = await loop.run_in_executor(None, sys.stdin.readline)
                print(f"Received input length: {len(line_bytes_str)}", file=sys.stderr, flush=True)

                if not line_bytes_str:
                    # stdin closed (EOF)
                    print("Stdin closed (EOF). Exiting stdin processing.", file=sys.stderr, flush=True)
                    break

                # readline() returns a string, no need to decode bytes
                line = line_bytes_str.strip()
                if not line:
                    print("Received empty line, continuing", file=sys.stderr, flush=True)
                    continue # Skip empty lines

                print(f"Received line: {line}", file=sys.stderr, flush=True) # Debug log

                request = json.loads(line)
                print(f"Parsed JSON request: {json.dumps(request)}", file=sys.stderr, flush=True)
                
                response = await self.handle_request(request)
                print(f"Generated response: {json.dumps(response)}", file=sys.stderr, flush=True)

                # Write response to stdout with explicit flush
                response_json = json.dumps(response)
                sys.stdout.write(response_json + '\n')
                sys.stdout.flush()  # Make sure to flush after each write
                
                print(f"Sent response for request ID: {response.get('id', 'N/A')}", file=sys.stderr, flush=True) # Debug log

            except json.JSONDecodeError as e:
                 print(f"JSON Decode Error: {str(e)} on line: {line}", file=sys.stderr, flush=True)
                 try:
                     if 'request' in locals() and isinstance(request, dict) and 'id' in request:
                         error_response = {
                             "id": request.get('id', 'error'),
                             "error": f"JSON decode error: {str(e)}",
                             "text": "Failed to parse JSON request"
                         }
                         sys.stdout.write(json.dumps(error_response) + '\n')
                         sys.stdout.flush()
                 except:
                     pass
            except asyncio.CancelledError:
                 print("Stdin processing task cancelled.", file=sys.stderr, flush=True)
                 break # Exit the loop if cancelled
            except Exception as e:
                 print(f"Request Handling/Stdin Error: {traceback.format_exc()}", file=sys.stderr, flush=True)
                 # Try to send an error response if possible
                 try:
                     if 'request' in locals() and request and isinstance(request, dict):
                         error_response = {
                             "id": request.get('id', 'error'),
                             "error": str(e),
                             "text": f"Error processing request: {str(e)}"
                         }
                         sys.stdout.write(json.dumps(error_response) + '\n')
                         sys.stdout.flush()
                 except:
                     pass  # If we can't send an error response, just continue
                         
                 # Avoid busy-looping on continuous errors
                 await asyncio.sleep(0.1)

        print("Stdin processing loop finished.", file=sys.stderr, flush=True) # Debug log

    async def start(self):
        """Starts the stdin processing task without heartbeats."""
        print("EchoStdioServer starting...", file=sys.stderr, flush=True)
        try:
            # Start processing stdin (no heartbeat task anymore)
            stdin_task = asyncio.create_task(self.process_stdin())

            # Keep running until stdin is closed or an error occurs
            await stdin_task
            print("EchoStdioServer shutdown complete", file=sys.stderr, flush=True)
        except Exception as e:
            print(f"Error in start method: {traceback.format_exc()}", file=sys.stderr, flush=True)

if __name__ == "__main__":
    # Print diagnostic information on startup
    print(f"Python version: {sys.version}", file=sys.stderr, flush=True)
    print(f"Python executable: {sys.executable}", file=sys.stderr, flush=True)
    print(f"Working directory: {os.getcwd()}", file=sys.stderr, flush=True)
    print(f"PYTHONPATH: {os.environ.get('PYTHONPATH', 'Not set')}", file=sys.stderr, flush=True)
    print(f"PYTHONIOENCODING: {os.environ.get('PYTHONIOENCODING', 'Not set')}", file=sys.stderr, flush=True)
    print(f"PYTHONUNBUFFERED: {os.environ.get('PYTHONUNBUFFERED', 'Not set')}", file=sys.stderr, flush=True)
    
    # Check if stdin/stdout are connected to a terminal
    print(f"stdin isatty: {sys.stdin.isatty()}", file=sys.stderr, flush=True)
    print(f"stdout isatty: {sys.stdout.isatty()}", file=sys.stderr, flush=True)
    print(f"stderr isatty: {sys.stderr.isatty()}", file=sys.stderr, flush=True)
    
    server = EchoStdioServer()
    try:
        print("Starting EchoStdioServer...", file=sys.stderr, flush=True)
        asyncio.run(server.start())
    except KeyboardInterrupt:
        print("Server stopped by user.", file=sys.stderr, flush=True)
    except Exception as e:
        # Catch any other unexpected errors during startup/runtime
        print(f"Unhandled exception in main: {traceback.format_exc()}", file=sys.stderr, flush=True)