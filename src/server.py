"""

server.py

This file sets up the SQLite Database, SocketIO Server and Flask WebServer and API.

"""

import jwt
import re
import pathlib
import urllib.parse
import hashlib
import os
from datetime import datetime, timezone
from typing import Literal

import sqlite3
import flask
from flask import Flask, request, session
import flask_socketio as io

from src.editor import *

# Huge server class encapsulates the processes the server must handle
class Server:
    DATE_FORMAT_STRING = '%Y-%m-%dT%H:%M:%S.%f'
    SALT_LENGTH = 16
    HASH_ITERATIONS = 10  # Choose a higher number for an actual application

    # Generates a salt, which makes reversing a leaked password hash difficult
    def generate_salt(self) -> bytes:
        # As recommended by the Python documentation
        # https://docs.python.org/3/library/hashlib.html
        return os.urandom(self.SALT_LENGTH)

    # Uses pkbdf2 hashing algorithm to hash the password and salt together
    def hash_password(self, password: bytes, salt: bytes) -> bytes:
        return hashlib.pbkdf2_hmac('sha256', password, salt, self.HASH_ITERATIONS)

    def __init__(self, app: Flask):
        self.app = app
        self.app.debug = True
        self.app.config['TEMPLATES_AUTO_RELOAD'] = True
        self.app.secret_key = b'This key can be anything' # Key used to encrypt session cookies

        # We disable async_handlers to make sure everything happens in order
        self.socketio = io.SocketIO(self.app, logger=True, async_handlers=False)

        db = pathlib.Path(__file__).parent.parent / 'editor.db'
        self.connection = sqlite3.connect(db, check_same_thread=False)

        self.open_files: dict[int, File] = {}

        self.registerSiteRoutes()
        self.registerAPIRoutes()
        self.registerEditorSocketEvents()

    # This function registers each page's flask site routes
    def registerSiteRoutes(self):

        # add_header disables caching of sites on the browser, so it always shows the most up to date content
        @self.app.after_request
        def add_header(response):
            response.headers['Cache-Control'] = 'no-store, must-revalidate'
            return response

        @self.app.route('/')
        def index():
            return flask.redirect('/dashboard')

        # Registers dashboard site route and retrieves the user's files and folders, sends you to login if necessary, returning you to the dashboard after you've logged in
        @self.app.route('/dashboard/')
        def dashboard():
            if not self.is_logged_in():
                return flask.redirect('/login?return=%2Fdashboard')

            root = self.connection.execute('SELECT RootFolderID FROM Users WHERE UserID = ?', (session['uid'], )).fetchone()[0]
            return flask.redirect(f'/folder/{root}')

        @self.app.route('/login')
        def login():
            return flask.render_template('login.html')

        # Registers shared site route part of the dashboard page and retrieves files and folders shared with the user, sends you to login if necessary, returning you to shared page after you've logged in
        @self.app.route('/shared')
        def shared():
            if not self.is_logged_in():
                return flask.redirect('/login?return=%2Fshared')

            folders = self.connection.execute(
                '''
                    SELECT f.FolderID, f.FolderName FROM Folders f
                        INNER JOIN UserFolderPerms AS own USING (FolderID)
                        LEFT JOIN (SELECT * FROM UserFolderPerms WHERE UserID = :uid) AS parent ON f.ParentFolderID = parent.FolderID
                        WHERE f.OwnerID != :uid AND own.UserID = :uid AND parent.PermissionID IS NULL
                ''',
                {'uid': session['uid']}
            ).fetchall()
            files = self.connection.execute(
                '''
                    SELECT f.FileID, f.FileName, t.FileType FROM Files f
                        INNER JOIN UserFilePerms AS own USING (FileID)
                        LEFT JOIN (SELECT * FROM UserFolderPerms WHERE UserID = :uid) AS parent ON f.ParentFolderID = parent.FolderID
                        JOIN FileType AS t USING (FileTypeID)
                        WHERE f.OwnerID != :uid AND own.UserID = :uid AND parent.PermissionID IS NULL
                ''',
                {'uid': session['uid']}
            ).fetchall()

            return flask.render_template('folder.html.j2',
                                         folderid=None,
                                         folders=({'id': id, 'name': name} for id, name in folders),
                                         files=({'id': id, 'name': name, 'type': type} for id, name, type in files),
                                         parents=[{'name': 'Shared Items'}]
                                         )

        # Registers site route of a generic folder, and fetches files and folders inside of that folder, redirects you to login if necessary 
        @self.app.route('/folder/<int:folderid>')
        def folder(folderid):
            if not self.is_logged_in():
                return flask.redirect(f'/login?return=%2Ffolder%2F{folderid}')

            perms = self.assert_has_permission(folderid, 'folder', 'Read')

            folders = self.connection.execute('SELECT FolderID, FolderName FROM Folders WHERE ParentFolderID = ?', (folderid, )).fetchall()
            files = self.connection.execute('SELECT FileID, FileName, FileType FROM Files JOIN FileType USING (FileTypeID) WHERE ParentFolderID = ?', (folderid, )).fetchall()

            # Used to find the parent folders that are displayed on the navigation bar
            parents = []
            previousid = currentid = folderid
            while currentid is not None:
                currentid, name = self.connection.execute('SELECT ParentFolderID, FolderName FROM Folders WHERE FolderID = ?', (currentid, )).fetchone()
                parents.append({'id': previousid, 'name': name})
                previousid = currentid
            parents.reverse()

            return flask.render_template('folder.html.j2',
                                         folderid=folderid,
                                         folders=({'id': id, 'name': name} for id, name in folders),
                                         files=({'id': id, 'name': name, 'type': type} for id, name, type in files),
                                         parents=parents,
                                         read_only=str(perms[0] == 'Read').lower()
                                         )

        # Registers site route of a generic file, putting you in a different page depending on if its a whiteboard file or a text file, doesn't necessarily send you to log in because user might have clicked a share link
        @self.app.route('/file/<int:fileid>')
        def file(fileid):
            response, perms = self.get_current_file_permission(fileid)
            if response is not None:
                return response

            name, filetype = self.connection.execute('SELECT FileName, FileType FROM Files JOIN FileType USING (FileTypeID) WHERE FileID = ?', (fileid, )).fetchone()

            template = ''
            match filetype:
                case 'Whiteboard':
                    template = 'whiteboard.html.j2'
                case 'Text':
                    template = 'text.html.j2'
                case _:
                    raise Exception('Unknown File')

            return flask.render_template(template,
                                         fileid=fileid,
                                         filename=name,
                                         read_only=str(perms == 'Read').lower()
                                         )
    # Registers api routes that clients request to call such as generating a share link or renaming a file
    def registerAPIRoutes(self):

        # Collects html form data, checks the username and password is valid, and then adds your account details and root folder to the database
        @self.app.route('/api/signup', methods=['POST'])
        def api_signup():
            username = request.form['username']
            password = request.form['password1']
            password2 = request.form['password2']

            if type(username) != str or type(password) != str or type(password2) != str or password != password2:
                raise Exception("Invalid Fields in Form")

            if username == '' or not username.isalnum() or password == '':
                raise Exception("Username or password not allowed")

            existing = self.connection.execute('SELECT 1 FROM Users WHERE Username = ?', (username, )).fetchone()
            if existing is not None:
                raise Exception("Username already exists")

            salt = self.generate_salt()
            hashed_password = self.hash_password(password.encode(), salt)
            now = datetime.now(timezone.utc).strftime(self.DATE_FORMAT_STRING)

            ex = self.connection.execute(
                'INSERT INTO Users(Username, PasswordHash, Salt, DateCreated) VALUES (?, ?, ?, ?)',
                (username, hashed_password.hex(), salt.hex(), now)
            )
            userid = ex.lastrowid

            ex = self.connection.execute(
                'INSERT INTO Folders(OwnerID, FolderName, DateCreated) VALUES (?, ?, ?)',
                (userid, f"{username}'s Home", now)
            )
            folderid = ex.lastrowid
            self.connection.execute('UPDATE Users SET RootFolderID = ? WHERE UserID = ?', (folderid, userid))
            self.connection.execute(
                'INSERT INTO UserFolderPerms(FolderID, UserID, PermissionID) SELECT ?, ?, PermissionID FROM Permissions WHERE PermissionType = \'Write\'',
                (folderid, userid)
            )
            self.connection.commit()

            return flask.redirect('/login')

        # Acquires html form data, checks it's valid, compares it to existing users in the database, and if details entered are correct takes you back to the site you were at previously
        @self.app.route('/api/login', methods=['POST'])
        def api_login():
            username = request.form['username']
            password = request.form['password']

            if type(username) != str or type(password) != str:
                raise Exception("Invalid Fields in Form")

            user = self.connection.execute('SELECT UserID, PasswordHash, Salt FROM Users WHERE Username = ?', (username,)).fetchone()
            if user is None:
                raise Exception("Username doesn't exist")

            userid, correct_hash, salt = user
            hashed_password = self.hash_password(password.encode(), bytes.fromhex(salt))
            if correct_hash != hashed_password.hex():
                raise Exception("Wrong password")

            session['uid'] = userid
            session['username'] = username

            url = urllib.parse.urlparse(request.referrer)
            queries = urllib.parse.parse_qs(url.query)
            return flask.redirect(urllib.parse.unquote(queries.get('return', ['%2Fdashboard'])[0]))

        # Clears session cookies, redirects you to login page and when you log back in you will be sent to the part of the dashboard where you clicked log out from
        @self.app.route('/api/logout', methods=['POST'])
        def api_logout():
            session.clear()
            return flask.redirect(request.referrer)

        # Updates file name stored in the database using html form input details, and then refers user back to the file page so the name is updated on their screen
        @self.app.route('/api/rename_file', methods=['POST'])
        def api_rename_file():
            if not self.is_logged_in():
                return flask.redirect('/login')

            fileid = request.form['fileid']
            filename = request.form['filename']
            self.assert_has_manage_permission(fileid, 'file')

            self.connection.execute('UPDATE Files SET FileName = ? WHERE FileId = ?', (filename, fileid))
            self.connection.commit()

            return flask.redirect(request.referrer)

        # Deletes file from the database based on file id, and redirects you to the folder the file used to be in
        @self.app.route('/api/delete_file', methods=['POST'])
        def api_delete_file():
            if not self.is_logged_in():
                return flask.redirect('/login')

            fileid = request.form['fileid']
            self.assert_has_manage_permission(fileid, 'file')
            parentid = self.get_parent_folder(fileid, 'file')

            self.connection.execute('DELETE FROM UserFilePerms WHERE FileId = ?', (fileid, ))
            self.connection.execute('DELETE FROM Files WHERE FileId = ?', (fileid, ))
            self.connection.commit()

            return flask.redirect('/folder/' + str(parentid))

        # Deletes non-home folder based on id, and redirects you to the parent folder of what you deleted
        @self.app.route('/api/delete_folder', methods=['POST'])
        def api_delete_folder():
            if not self.is_logged_in():
                return flask.redirect('/login')

            folderid = request.form['folderid']

            self.assert_has_manage_permission(folderid, 'folder')

            parentid = self.get_parent_folder(folderid, 'folder')

            if parentid is None:
                raise Exception('Cannot delete your Home Folder')

            # Recursively deletes all of the files and folders inside of the folder the user deleted
            def delete_folder_recursive(folderid):
                subfolders = self.connection.execute('SELECT FolderID FROM Folders WHERE ParentFolderID = ?', (folderid, )).fetchall()
                for subfolder in subfolders:
                    delete_folder_recursive(subfolder[0])

                files = self.connection.execute('SELECT FileID FROM Files WHERE ParentFolderID = ?', (folderid, )).fetchall()
                for file in files:
                    self.connection.execute('DELETE FROM UserFilePerms WHERE FileId = ?', (file[0], ))
                    self.connection.execute('DELETE FROM Files WHERE FileId = ?', (file[0], ))

                self.connection.execute('DELETE FROM UserFolderPerms WHERE FolderId = ?', (folderid, ))
                self.connection.execute('DELETE FROM Folders WHERE FolderId = ?', (folderid, ))

            delete_folder_recursive(folderid)
            self.connection.commit()

            return flask.redirect('/folder/' + str(parentid))

        # Collects html form data on what you want the folder to be called, checks you have permission and then adds a new folder to the database, and refers you back to the page you were on
        @self.app.route('/api/create_folder', methods=['POST'])
        def api_create_folder():
            if not self.is_logged_in():
                return flask.redirect('/login')

            foldername = request.form['foldername']
            folderid = request.form['folderid']
            self.assert_has_permission(folderid, 'folder', 'Write')

            now = datetime.now(timezone.utc).strftime(self.DATE_FORMAT_STRING)

            ex = self.connection.execute(
                'INSERT INTO Folders(ParentFolderID, OwnerID, FolderName, DateCreated, DateLastModified) VALUES (?, ?, ?, ?, ?)',
                (folderid, session['uid'], foldername, now, now)
            )
            self.connection.execute(
                'INSERT INTO UserFolderPerms(FolderID, UserID, PermissionID) SELECT ?, ?, PermissionID FROM UserFolderPerms WHERE FolderID = ?',
                (ex.lastrowid, session['uid'], folderid)
            )
            self.connection.commit()

            return flask.redirect(request.referrer)

        # Collects html form data on what you want the file to be called, checks you have the permissions and then adds a new file to the database, depending on if its text or whtieboard, and refers you to the page you were on before
        @self.app.route('/api/create_file', methods=['POST'])
        def api_create_file():
            if not self.is_logged_in():
                return flask.redirect('/login')

            filename = request.form['filename']
            filetype = request.form['filetype']
            folderid = request.form['folderid']
            self.assert_has_permission(folderid, 'folder', 'Write')

            content = ''
            match filetype:
                case 'Text':
                    content = TextFileData().model_dump_json()
                case 'Whiteboard':
                    content = WhiteboardFileData().model_dump_json()
                case _:
                    raise Exception('Unknown File Type')

            now = datetime.now(timezone.utc).strftime(self.DATE_FORMAT_STRING)

            ex = self.connection.execute(
                'INSERT INTO Files(ParentFolderID, OwnerID, FileName, FileContent, DateCreated, DateLastModified, FileTypeID) SELECT ?, ?, ?, ?, ?, ?, FileTypeID FROM FileType WHERE FileType = ?',
                (folderid, session['uid'], filename, content, now, now, filetype)
            )
            self.connection.execute(
                'INSERT INTO UserFilePerms(FileID, UserID, PermissionID) SELECT ?, ?, PermissionID FROM UserFolderPerms WHERE FolderID = ?',
                (ex.lastrowid, session['uid'], folderid)
            )
            self.connection.commit()

            return flask.redirect(request.referrer)

        # Generates a share link by signing the ID of the file and the permission you want to give the share link together, and then returns the link in json format to be presented to the user
        @self.app.route('/api/share_link', methods=['POST'])
        def api_share_link():
            if not self.is_logged_in():
                return flask.redirect('/login')

            fileid = request.form['fileid']
            permission = request.form['permission']
            self.assert_has_manage_permission(fileid, 'file')

            token = jwt.encode({'fileid': fileid, 'permission': permission}, self.app.secret_key, algorithm="HS256") # Signed so that user can't easily change the link's permission and username

            return flask.jsonify({
                "shareLink": flask.request.host + f'/file/{fileid}?token=' + token,
                "status": "Success"
            })

        # Collects html form data on the username the user chose to share with, and the permission type, and executes the necessary commands to the database so that the invited user can see the file in their dashboard
        @self.app.route('/api/share_file', methods=['POST'])
        def api_share_file():
            if not self.is_logged_in():
                return flask.redirect('/login')

            fileid = request.form['fileid']
            shared_username = request.form['shared_username']
            permission = request.form['permission']
            self.assert_has_manage_permission(fileid, 'file')

            shared_userid = self.connection.execute(
                'SELECT UserID FROM Users WHERE Username = ?', (shared_username, )
            ).fetchone()
            if shared_userid is None:
                raise Exception('User doesn\'t exist')

            perm = self.connection.execute('SELECT PermissionID FROM Permissions WHERE PermissionType = ?', (permission, )).fetchone()
            if perm is None:
                raise Exception('Unknown permission')
            permissionid = perm[0]

            self.connection.execute(
                '''INSERT INTO UserFilePerms(FileID, UserID, PermissionID) SELECT :fid, :uid, :pid
                    ON CONFLICT DO UPDATE SET PermissionID = :pid WHERE :pid > PermissionID''',
                {'fid': fileid, 'uid': shared_userid[0], 'pid': permissionid}
            )
            self.connection.commit()

            return flask.redirect(request.referrer)

        # Collects html form data on the username and permission assigned, and recursively shares every file and folder in the folder that was initially shared with the user
        @self.app.route('/api/share_folder', methods=['POST'])
        def api_share_folder():
            if not self.is_logged_in():
                return flask.redirect('/login')

            folderid = request.form['folderid']
            shared_username = request.form['shared_username']
            permission = request.form['permission']

            self.assert_has_manage_permission(folderid, 'folder')

            shared_userid = self.connection.execute(
                'SELECT UserID FROM Users WHERE Username = ?', (shared_username, )
            ).fetchone()
            if shared_userid is None:
                raise Exception('User doesn\'t exist')

            perm = self.connection.execute('SELECT PermissionID FROM Permissions WHERE PermissionType = ?', (permission, )).fetchone()
            if perm is None:
                raise Exception('Unknown permission')
            permissionid = perm[0]

            def share_folder_recursive(folderid):
                self.connection.execute(
                    '''INSERT INTO UserFolderPerms(FolderID, UserID, PermissionID) VALUES (:fid, :uid, :pid)
                        ON CONFLICT DO UPDATE SET PermissionID = :pid WHERE :pid > PermissionID''',
                    {'fid': folderid, 'uid': shared_userid[0], 'pid': permissionid}
                )
                self.connection.execute(
                    '''INSERT INTO UserFilePerms(FileID, UserID, PermissionID) SELECT FileID, :uid, :pid FROM Files WHERE ParentFolderID = :fid
                        ON CONFLICT DO UPDATE SET PermissionID = :pid WHERE :pid > PermissionID''',
                    {'fid': folderid, 'uid': shared_userid[0], 'pid': permissionid}
                )

                subfolders = self.connection.execute('SELECT FolderID FROM Folders WHERE ParentFolderID = ?', (folderid, )).fetchall()
                for subfolder in subfolders:
                    share_folder_recursive(subfolder[0])

            share_folder_recursive(folderid)
            self.connection.commit()

            return flask.redirect(request.referrer)

    # Creates functions that handle a particular event that occurs in either the whiteboard or text file, e.g. removing text from text editor or drawing to whiteboard 
    def registerEditorSocketEvents(self):

        # When a user tries to connect to a file, uses regex on the URL, makes sure you have permission to access the file, and sets up an instantiated text/whiteboard file object which it returns
        def connect_file() -> File:
            url = urllib.parse.urlparse(request.referrer)
            match = re.match(r'\/file\/(\d+)$', url.path) # Gets the file ID from the URL
            if match.group(1) is None:
                raise Exception('File not found')
            fileid = int(match.group(1))

            response, perms = self.get_current_file_permission(fileid)
            if response is not None:
                raise Exception('Permission denied')

            if fileid not in self.open_files:
                ex = self.connection.execute('SELECT FileContent, FileName, FileType FROM Files JOIN FileType USING (FileTypeID) WHERE FileID = ?', (fileid, )).fetchone()
                if ex is None:
                    raise Exception('File not found')

                content, name, type = ex

                match type:
                    case 'Whiteboard':
                        file = WhiteboardFile(fileid, name)
                        file.parse(content)
                        self.open_files[fileid] = file
                    case 'Text':
                        file = TextFile(fileid, name)
                        file.parse(content)
                        self.open_files[fileid] = file

            file = self.open_files[fileid]

            with file.mutex:
                uid = file.next_user_id
                file.next_user_id += 1

                file.users[uid] = User(
                    uid,
                    session['username'] if 'username' in session else 'Guest',
                    file,
                    0, -1,
                    perms == 'Read'
                )

            session['socket_uid'] = uid
            session['file_id'] = file.id
            io.join_room(file.id)

            return file

        # This function is called when the client opens up a websocket, it sends the contents and properties of the text file to the user
        @self.socketio.event(namespace='/text')
        def connect():
            file: TextFile = connect_file()
            with file.mutex:
                user = file.users[session['socket_uid']]

                mod_id = file.modify(user, CursorModification(user.id, 0))
                user.set_last_mod_id(mod_id)

                io.emit('connected', (user.id, file.data.content, mod_id))

                for name, prop in file.data.properties.items():
                    match prop:
                        case BasicPropertyRange() as prop:
                            for range in prop.ranges:
                                io.emit('add_property', (range[0], range[1], name, None, -1, mod_id), to=file.id)

                        case FlaggedPropertyRange() as prop:
                            for flag, ranges in prop.ranges.items():
                                for range in ranges:
                                    io.emit('add_property', (range[0], range[1], name, flag, -1, mod_id), to=file.id)

                for other in file.users.values():
                    if other != user:
                        io.emit('cursor_moved', (other.position, other.id, other.username, mod_id))

                if not user.read_only:
                    io.emit('cursor_moved', (user.position, user.id, user.username, mod_id), to=file.id, include_self=False)

        # Handles what should be done if a user disconnects from a text file, such as saving the file to the database and closing the file session if it was the last user connected
        @self.socketio.event(namespace='/text')
        def disconnect():
            if 'socket_uid' not in session:
                return

            file = self.open_files[session['file_id']]
            with file.mutex:
                user = file.users[session['socket_uid']]
                del file.users[user.id]

                if len(file.users) == 0:
                    self.connection.execute('UPDATE Files SET FileContent = ? WHERE FileId = ?', (file.stringify(), file.id))
                    self.connection.commit()
                    del self.open_files[file.id]
                else:
                    file.recalculate_first_mod_id()
                    io.emit('user_disconnected', user.id, to=user.file.id)

        # Updates last modification ID for text files, largely helpful for synchronisation
        @self.socketio.event(namespace='/text')
        def update_last_mod_id(last_mod_id):
            file: TextFile = self.open_files[session['file_id']]
            with file.mutex:
                user = file.users[session['socket_uid']]
                if user.read_only:
                    return

                user.set_last_mod_id(last_mod_id)

        # Emits cursor movement event to all users if the user is allowed to do the event i.e. has write permissions
        @self.socketio.event(namespace='/text')
        def cursor_moved(position, last_mod_id):
            file: TextFile = self.open_files[session['file_id']]
            with file.mutex:
                user = file.users[session['socket_uid']]
                if user.read_only:
                    return

                user.set_last_mod_id(last_mod_id)
                mod_id, mod = file.move_cursor(user, position)
                io.emit('cursor_moved', (mod.position, user.id, user.username, mod_id), to=file.id)

        # Emits removal of text between a start and end position event to all users if the user is allowed to do the event i.e. has write permissions
        @self.socketio.event(namespace='/text')
        def remove_region(start, end, last_mod_id):
            file: TextFile = self.open_files[session['file_id']]
            with file.mutex:
                user = file.users[session['socket_uid']]
                if user.read_only:
                    return

                user.set_last_mod_id(last_mod_id)
                mod_id, mod = file.remove(user, start, end)
                io.emit('remove_region', (mod.start, mod.end, user.id, mod_id), to=file.id)

        # Emits addition of a string of text from a starting position event to all users if the user is allowed to do the event i.e. has write permissions
        @self.socketio.event(namespace='/text')
        def add_region(text, position, last_mod_id):
            file: TextFile = self.open_files[session['file_id']]
            with file.mutex:
                user = file.users[session['socket_uid']]
                if user.read_only:
                    return

                user.set_last_mod_id(last_mod_id)
                mod_id, mod = file.add(user, text, position)
                io.emit('add_region', (text, mod.position, user.id, mod_id), to=file.id)

        # Emits property removal event to all users and checks whether the user is allowed to do the event i.e. has write permissions
        @self.socketio.event(namespace='/text')
        def remove_property(start, end, property, last_mod_id):
            file: TextFile = self.open_files[session['file_id']]
            with file.mutex:
                user = file.users[session['socket_uid']]
                if user.read_only:
                    return

                user.set_last_mod_id(last_mod_id)
                mod_id, mod = file.remove_property(user, start, end, property)
                io.emit('remove_property', (mod.start, mod.end, mod.property, user.id, mod_id), to=file.id)

        # Emits property addition event to all users and checks whether the user is allowed to do the event i.e. has write permissions
        @self.socketio.event(namespace='/text')
        def add_property(start, end, property, flag, last_mod_id):
            file: TextFile = self.open_files[session['file_id']]
            with file.mutex:
                user = file.users[session['socket_uid']]
                if user.read_only:
                    return

                user.set_last_mod_id(last_mod_id)
                mod_id, mod = file.add_property(user, start, end, property, flag)
                io.emit('add_property', (mod.start, mod.end, mod.property, mod.flag, user.id, mod_id), to=file.id)

        # Handles the connection of a user to a whiteboard file, including recursively adding all of the group and path elements on that file to the user's whiteboard 
        @self.socketio.event(namespace='/whiteboard')
        def connect():
            file: WhiteboardFile = connect_file()

            with file.mutex:
                def recursive_add(id, ele):
                    match ele:
                        case GroupElement() as ele:
                            for child_id, child in ele.children.items():
                                recursive_add(child_id, child)  # Use of recursion and tree
                            io.emit('group', (id, list(ele.children.keys())))

                        case PathElement() as ele:
                            io.emit('draw', (id, ele.path))

                for id, ele in file.data.elements.items():
                    recursive_add(id, ele)

        # Handles a user disconnecting from a whiteboard file, including saving the file content and deleting the session if the last user connected has left
        @self.socketio.event(namespace='/whiteboard')
        def disconnect():
            if 'socket_uid' not in session:
                return

            file = self.open_files[session['file_id']]
            with file.mutex:
                user = file.users[session['socket_uid']]
                del file.users[user.id]

                if len(file.users) == 0:
                    self.connection.execute('UPDATE Files SET FileContent = ? WHERE FileId = ?', (file.stringify(), file.id))
                    self.connection.commit()
                    del self.open_files[file.id]
                else:
                    io.emit('user_disconnected', user.id, to=file.id)

        # Emits whiteboard drawing event to all users and checks whether the user is allowed to do the event i.e. has write permissions
        @self.socketio.event(namespace='/whiteboard')
        def draw(id, path):
            file: WhiteboardFile = self.open_files[session['file_id']]
            with file.mutex:
                user = file.users[session['socket_uid']]
                if user.read_only:
                    return

                file.draw(id, path)
                io.emit('draw', (id, path), to=file.id, include_self=False)

        # Emits whiteboard removal of an element event to all users and checks whether the user is allowed to do the event i.e. has write permissions
        @self.socketio.event(namespace='/whiteboard')
        def remove(id):
            file: WhiteboardFile = self.open_files[session['file_id']]
            with file.mutex:
                user = file.users[session['socket_uid']]
                if user.read_only:
                    return

                file.remove(id)
                io.emit('remove', (id, ), to=file.id, include_self=False)

        # Emits whiteboard path modification event to all users and checks whether the user is allowed to do the event i.e. has write permissions
        @self.socketio.event(namespace='/whiteboard')
        def edit(id, new_path):
            file: WhiteboardFile = self.open_files[session['file_id']]
            with file.mutex:
                user = file.users[session['socket_uid']]
                if user.read_only:
                    return

                file.edit(id, new_path)
                io.emit('edit', (id, new_path), to=file.id, include_self=False)

        # Emits whiteboard grouping event to all users and checks whether the user is allowed to do the event i.e. has write permissions
        @self.socketio.event(namespace='/whiteboard')
        def group(group_id, ids):
            file: WhiteboardFile = self.open_files[session['file_id']]
            with file.mutex:
                user = file.users[session['socket_uid']]
                if user.read_only:
                    return

                file.group(group_id, ids)
                io.emit('group', (group_id, ids), to=file.id, include_self=False)

        # Emits whiteboard ungrouping event to all users and checks whether the user is allowed to do the event i.e. has write permissions
        @self.socketio.event(namespace='/whiteboard')
        def ungroup(group_id):
            file: WhiteboardFile = self.open_files[session['file_id']]
            with file.mutex:
                user = file.users[session['socket_uid']]
                if user.read_only:
                    return

                file.ungroup(group_id)
                io.emit('ungroup', (group_id, ), to=file.id, include_self=False)

    # Returns a boolean to check if a user is logged in, so it can be determined whether a user must reauthenticate
    def is_logged_in(self) -> bool:
        return 'uid' in session

    # Attempts to get the ID of the parent folder of the file/folder ID that was passed into the function
    def get_parent_folder(self, id: int, type: Literal['file', 'folder']) -> int:
        parentid = self.connection.execute(
            f'SELECT ParentFolderID FROM {type.capitalize()}s WHERE {type.capitalize()}ID = ?', (id, )
        ).fetchone()
        if parentid is None:
            raise Exception(f'{type.capitalize()} doesn\'t exist')

        return parentid[0]

    # Checks that a user has manage permissions, and raises an exception if they do not
    def assert_has_manage_permission(self, id: int, type: Literal['file', 'folder']):
        # A file is considered to have Manage permissions, if the user has Write permission on the parent folder
        parentid = self.get_parent_folder(id, type)

        if parentid is None:
            assert type == 'folder'

            # This is a Root Folder
            owner = self.connection.execute(
                'SELECT OwnerID FROM Folders WHERE FolderID = ?', (id, )
            ).fetchone()

            if owner[0] != session['uid']:
                raise Exception('Permission denied')

        else:
            self.assert_has_permission(parentid, 'folder', 'Write')
    
    # Checks if a user has a particular permission in a particular file/folder, and raises an exception if they do not, returns the type of permission they have if they do have read/write permission
    def assert_has_permission(self, id: int, type: Literal['file', 'folder'], permission: Literal['Read', 'Write']) -> Literal['Read', 'Write']:
        perms = self.connection.execute(
            f'SELECT PermissionType FROM User{type.capitalize()}Perms JOIN Permissions USING (PermissionID) WHERE UserID = ? AND {type.capitalize()}ID = ?' +
            (" AND PermissionType = 'Write'" if permission == 'Write' else ''),
            (session['uid'], id)
        ).fetchone()

        if perms is None:
            raise Exception('Permission denied')

        return perms[0]

    # Attempts to get a user's permissions they have for a particular file based on link and database content
    def get_current_file_permission(self, id) -> tuple[flask.Response, Literal['Read', 'Write']]:
        token = request.args.get('token')
        if token is None:
            url = urllib.parse.urlparse(request.referrer)
            queries = urllib.parse.parse_qs(url.query)
            token = queries.get('token', [None])[0]

        perms = ''
        if token is not None:
            json = jwt.decode(token, self.app.secret_key, algorithms=["HS256"])
            if json['fileid'] != str(id):
                raise Exception('Invalid token')

            perms = json['permission']

            ex = self.connection.execute('SELECT PermissionID FROM Permissions WHERE PermissionType = ?', (perms, )).fetchone()
            if ex is None:
                raise Exception('Unknown permission')

        else:
            if not self.is_logged_in():
                return flask.redirect(f'/login?return=%2Ffile%2F{id}'), None

            ex = self.connection.execute(
                'SELECT PermissionType FROM UserFilePerms JOIN Permissions USING (PermissionID) WHERE UserID = ? AND FileID = ?',
                (session['uid'], id)
            ).fetchone()
            if ex is None:
                raise Exception('Permission denied')

            perms = ex[0]

        return None, perms

    def run(self, host='0.0.0.0'):
        self.socketio.run(self.app, host)