"""

main.py

This is the file that should be executed to start the code

"""

from src.server import Server
from flask import Flask

server = Server(Flask(__name__))

if __name__ == '__main__':
    server.run()