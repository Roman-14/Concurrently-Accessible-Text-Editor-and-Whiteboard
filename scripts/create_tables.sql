CREATE TABLE FileType (
    FileTypeID integer PRIMARY KEY,
    FileType text
);

CREATE TABLE Folders (
    FolderID integer PRIMARY KEY,
    ParentFolderID int,
    OwnerID int,
    FolderName text,
    DateCreated text,
    DateLastModified text,
    FOREIGN KEY (ParentFolderID) REFERENCES Folders(FolderID),
    FOREIGN KEY (OwnerID) REFERENCES Users(UserID)
);

CREATE TABLE Files (
    FileID integer PRIMARY KEY,
    ParentFolderID int,
    FileTypeID int,
    OwnerID int,
    FileName text,
    FileContent text,
    DateCreated text,
    DateLastModified text,
    FOREIGN KEY (ParentFolderID) REFERENCES Folders(FolderID),
    FOREIGN KEY (FileTypeID) REFERENCES FileType(FileTypeID),
    FOREIGN KEY (OwnerID) REFERENCES Users(UserID)
);

CREATE TABLE Users (
    UserID integer PRIMARY KEY,
    Username text,
    PasswordHash text,
    Salt text,
    DateCreated text,
    RootFolderID int null,
    FOREIGN KEY (RootFolderID) REFERENCES Folders(FolderID)
);

CREATE TABLE Permissions (
    PermissionID integer PRIMARY KEY,
    PermissionType text
);

CREATE TABLE UserFolderPerms (
    FolderID int,
    UserID int,
    PermissionID int,
    PRIMARY KEY (FolderID, UserID),
    FOREIGN KEY (FolderID) REFERENCES Folders(FolderID),
    FOREIGN KEY (UserID) REFERENCES Users(UserID),
    FOREIGN KEY (PermissionID) REFERENCES Permissions(PermissionID)
);

CREATE TABLE UserFilePerms (
    FileID int,
    UserID int,
    PermissionID int,
    PRIMARY KEY (FileID, UserID),
    FOREIGN KEY (FileID) REFERENCES Files(FileID),
    FOREIGN KEY (UserID) REFERENCES Users(UserID),
    FOREIGN KEY (PermissionID) REFERENCES Permissions(PermissionID)
);