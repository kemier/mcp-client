import asyncio
import json
import sys
import traceback
from typing import Dict, Optional

class EchoStdioServer:
    def __init__(self):
        self.model_configs: Dict[str, dict] = {
            "echo-test": {
                "max_tokens": 100,
                "temperature": 0.7
            }
        }

    async def handle_request(self, request: dict) -> dict:
        request_id = request.get('id', None) # Capture request ID if present
        response_base = {"id": request_id} if request_id else {}

        if request.get('type') == 'check':
            return {**response_base, "type": "response", "status": "healthy"}

        text = request.get('text', '')
        model = request.get('model', 'echo-test')
        # Options are not used in this simple echo, but good practice
        # options = request.get('options', {})

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

    async def send_heartbeat(self):
        """Sends heartbeat messages periodically to stdout."""
        while True:
            try:
                heartbeat = {
                    "type": "heartbeat",
                    "models": list(self.model_configs.keys())
                }
                # Write heartbeat to stdout
                print(json.dumps(heartbeat), flush=True)
            except Exception as e:
                print(f"Heartbeat Error: {str(e)}", file=sys.stderr, flush=True)
            await asyncio.sleep(5) # Send less frequently maybe

    async def process_stdin(self):
        """Reads requests from stdin using run_in_executor and writes responses to stdout."""
        loop = asyncio.get_running_loop() # Get the current running loop
        print("Starting stdin processing using run_in_executor.", file=sys.stderr, flush=True) # Debug log

        while True:
            line = None # Initialize line for error logging
            try:
                # Run the blocking sys.stdin.readline in the default ThreadPoolExecutor
                line_bytes_str = await loop.run_in_executor(None, sys.stdin.readline)

                if not line_bytes_str:
                    # stdin closed (EOF)
                    print("Stdin closed (EOF). Exiting stdin processing.", file=sys.stderr, flush=True)
                    break

                # readline() returns a string, no need to decode bytes
                line = line_bytes_str.strip()
                if not line:
                    continue # Skip empty lines

                print(f"Received line: {line}", file=sys.stderr, flush=True) # Debug log

                request = json.loads(line)
                response = await self.handle_request(request)

                # Write response to stdout
                print(json.dumps(response), flush=True)
                print(f"Sent response for request ID: {response.get('id', 'N/A')}", file=sys.stderr, flush=True) # Debug log

            except json.JSONDecodeError as e:
                 print(f"JSON Decode Error: {str(e)} on line: {line}", file=sys.stderr, flush=True)
            except asyncio.CancelledError:
                 print("Stdin processing task cancelled.", file=sys.stderr, flush=True)
                 break # Exit the loop if cancelled
            except Exception as e:
                 print(f"Request Handling/Stdin Error: {traceback.format_exc()}", file=sys.stderr, flush=True)
                 # Decide if we should break the loop on other errors or try to continue
                 # For robustness, let's try to continue unless it's EOF
                 await asyncio.sleep(0.1) # Avoid busy-looping on continuous errors

        print("Stdin processing loop finished.", file=sys.stderr, flush=True) # Debug log

    async def start(self):
        """Starts the heartbeat and stdin processing tasks."""
        # Start heartbeat task
        heartbeat_task = asyncio.create_task(self.send_heartbeat())
        # Start processing stdin
        stdin_task = asyncio.create_task(self.process_stdin())

        # Keep running until stdin is closed or an error occurs
        await stdin_task
        # Optionally cancel heartbeat when done
        heartbeat_task.cancel()

if __name__ == "__main__":
    server = EchoStdioServer()
    try:
        asyncio.run(server.start())
    except KeyboardInterrupt:
        print("Server stopped by user.", file=sys.stderr, flush=True)
    except Exception as e:
        # Catch any other unexpected errors during startup/runtime
        print(f"Unhandled exception in main: {traceback.format_exc()}", file=sys.stderr, flush=True)