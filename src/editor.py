"""

editor.py

This file contains the server side functionality of the text editor and whiteboard

"""

from typing import Callable, TypeAlias, Union
from dataclasses import dataclass
from threading import Lock
from collections.abc import Generator
from pydantic import BaseModel, Field

import typing
if typing.TYPE_CHECKING:
    from src.server import Server

# User class encapsulates important information that must be known about users
@dataclass
class User:
    id: int

    username: str
    file: 'File'
    position: int
    last_mod_id: int # last_mod_id is used to identify desynchronisations between the server's text file and the client's text file
    read_only: bool

    # Sets the id of the last modification made to a file, calls to recalculate it if necessary
    def set_last_mod_id(self, last_mod_id):
        if last_mod_id <= self.last_mod_id:
            return

        was_holding_up = self.last_mod_id == self.file.first_mod_id
        self.last_mod_id = last_mod_id

        if was_holding_up:
            self.file.recalculate_first_mod_id()

# Standard modification class, contains apply method which is designed to be overriden
@dataclass
class Modification:
    userid: int

    def apply(self, user: User):
        pass

# AddModification takes in text that was added to the file, and the indexable position it was added at
@dataclass
class AddModification(Modification):
    text: str
    position: int

    # Overrides empty apply method inherited from Modification class, inserts the text addition to the text file content, and then calls a function to update every users cursor position and property ranges
    def apply(self, user: User):
        file: TextFile = user.file

        file.data.content = user.file.data.content[:self.position] \
            + self.text.replace('\r', '') \
            + user.file.data.content[self.position:]

        file.shift_all_fixed_points(lambda pos: pos + len(self.text) if pos > self.position else pos)

# RemoveModification takes a start and end position of the area that was selected to be removed from the text editor
@dataclass
class RemoveModification(Modification):
    start: int
    end: int

    # Overrides empty apply method inherited from Modification class, applies text removal to the text file, updates all users cursor positions, and then updates redundant property ranges
    def apply(self, user: User):
        file: TextFile = user.file
        file.data.content = user.file.data.content[:self.start] + user.file.data.content[self.end:]
        file.shift_all_fixed_points(lambda pos: pos - min(self.end, pos) - self.start if pos > self.start else pos)
        file.remove_empty_property_ranges()

# Adds a new property to a certain area of the text, e.g. making a certain area bold. Takes in start and end range, the property you want to add, and an optional flag if a property has characteristics e.g. a font size
@dataclass
class AddPropertyModification(Modification):
    start: int
    end: int
    property: str
    flag: str | None

    # Overrides apply method inherited by the Modification class. Applies the property to the right part of the text file.
    def apply(self, user: User):
        if self.start > self.end:
            return

        if self.property in user.file.data.properties: # Removes property if you try to do the same property twice in the same place
            RemovePropertyModification(self.userid, self.start, self.end, self.property).apply(user)

            match user.file.data.properties[self.property]:
                case BasicPropertyRange() as prop:
                    ranges = prop.ranges
                case FlaggedPropertyRange() as prop:
                    ranges = prop.ranges.get(self.flag, [])

            was_added = False
            for range in ranges:
                if range[1] == self.start:
                    range[1] = self.end
                    was_added = True
                elif range[0] == self.end:
                    range[1] = self.start
                    was_added = True

            if not was_added:
                ranges.append((self.start, self.end))
        else: # Adds the property if it hasnt been done in the given start to end range before
            file: 'TextFile' = user.file
            if self.flag is not None:
                file.data.properties[self.property] = FlaggedPropertyRange(ranges={self.flag: [(self.start, self.end)]})
            else:
                file.data.properties[self.property] = BasicPropertyRange(ranges=[(self.start, self.end)])

# RemovePropertyModification takes in the property type and a start and end position of the removal. Handles the removal of properties.
@dataclass
class RemovePropertyModification(Modification):
    start: int
    end: int
    property: str

    # cutOverlaps removes the range given by self.start to self.end from each range in the ranges parameter
    def cutOverlaps(self, ranges: list[tuple[int, int]]) -> list[tuple[int, int]]:
        new_ranges = []
        for range in ranges:
            if range[0] >= self.start:
                if range[1] > self.end:
                    new_ranges.append([max(self.end, range[0]), range[1]])
            else:
                if range[1] > self.end:
                    new_ranges.append([range[0], self.start])
                    new_ranges.append([self.end, range[1]])
                else:
                    new_ranges.append([range[0], min(self.start, range[1])])

        return new_ranges

    # Overrides apply method inherited by the Modification class. Applies the removal of a property between a given region, accounting for whether it has a flagged attribute or not.
    def apply(self, user: User):
        if self.property in user.file.data.properties:
            match user.file.data.properties[self.property]:
                case BasicPropertyRange() as prop:
                    prop.ranges = self.cutOverlaps(prop.ranges)
                    if len(prop.ranges) == 0:
                        del user.file.data.properties[self.property]

                case FlaggedPropertyRange() as prop:
                    for flag in list(prop.ranges.keys()):
                        prop.ranges[flag] = self.cutOverlaps(prop.ranges[flag])
                        if len(prop.ranges[flag]) == 0:
                            del prop.ranges[flag]

                    if len(prop.ranges) == 0:
                        del user.file.data.properties[self.property]

# CursorModification represents a modification in a cursor's position
@dataclass
class CursorModification(Modification):
    position: int

    # Overrides apply method inherited by the Modification class. Applies a change in a user's cursor position
    def apply(self, user: User):
        user.position = self.position


Element: TypeAlias = Union['PathElement', 'GroupElement']

# PathElement is a class used inside of the whiteboard to define a path (a group of lines)
# It inherits from pydantic::BaseModel, which makes it easy to be serialized and saved to/loaded from a database
class PathElement(BaseModel):
    path: str = Field(default='')

# GroupElement is a class used inside of the whiteboard to define a group (a group of groups/paths)
# It inherits from pydantic::BaseModel, which makes it easy to be serialized and saved to/loaded from a database
class GroupElement(BaseModel):
    children: dict[str, Element] = Field(default={})

# File class defines necessary information the server must know about a file
@dataclass
class File:
    mutex: Lock
    id: int
    name: str
    users: dict[int, User]
    next_user_id: int

    # Stringify is designed to be overriden so it can be serialized for database storage depending on the file type
    def stringify(self) -> str:
        assert (False)

    # Parse is designed to be overriden so it can take in the output of .stringify() to initiliaze the object
    def parse(self, content: str):
        assert (False)

# WhiteboardFileData manages the elements (the groups and paths) inside of a whiteboard file
class WhiteboardFileData(BaseModel):
    elements: dict[str, Element] = Field(default={})

# WhiteboardFile is a child of the File class designed to make objects with attributes and methods helpful to a whiteboard file
class WhiteboardFile(File):
    data: WhiteboardFileData
    all_elements: dict[str, Element]

    def __init__(self, id: int, name: str):
        super().__init__(Lock(), id, name, {}, 0)
        self.data = WhiteboardFileData()
        self.all_elements = {}

    # Draw function gets called when someone sends a draw message through the websocket
    def draw(self, id: str, path: str):
        self.data.elements[id] = PathElement(path=path)
        self.all_elements[id] = self.data.elements[id]

    # Removes an element, if it is a GroupElement all its children get removed recursively
    def remove(self, id: str):
        def recursive_remove(id):
            if id not in self.all_elements:
                return

            ele = self.all_elements[id]
            del self.all_elements[id]

            match ele:
                case GroupElement() as ele:
                    for child_id in ele.children:
                        recursive_remove(child_id)

        del self.data.elements[id]
        recursive_remove(id)

    # Modifies a path in the all_elements dictionary
    def edit(self, id: str, new_path: str):
        ele: PathElement = self.all_elements[id]
        ele.path = new_path

    # Uses tree based grouping to group two or more elements together from their ids, removing the ungrouped versions from the list after
    def group(self, group_id: str, ids: list[str]):
        self.data.elements[group_id] = GroupElement(children={id: self.data.elements[id] for id in ids})
        for id in ids:
            del self.data.elements[id]

        self.all_elements[group_id] = self.data.elements[group_id]

    # Uses a tree to ungroup elements that were previously in a group from its group_id
    def ungroup(self, group_id: str):
        group: GroupElement = self.data.elements[group_id]
        for id, ele in group.children.items():
            self.data.elements[id] = ele

        del self.data.elements[group_id]
        del self.all_elements[group_id]

    # Serializes whiteboard file's data so that it is ready to be stored in a database
    def stringify(self) -> str:
        return self.data.model_dump_json()

    # Parses the serialized content string paremeter into an object that the code can interpret once again recursively
    def parse(self, content: str):
        self.data = WhiteboardFileData.model_validate_json(content)

        def walk_elements(id: str, ele: Element):
            self.all_elements[id] = ele

            match ele:
                case GroupElement() as ele:
                    for child_id, child in ele.children.items():
                        walk_elements(child_id, child)

        for id, ele in self.data.elements.items():
            walk_elements(id, ele)

# A class used to represent a range of positions that a basic property has been applied to a file 
class BasicPropertyRange(BaseModel):
    ranges: list[tuple[int, int]]

# A class used to represent a range of positions that a flagged property has been applied to a file 
class FlaggedPropertyRange(BaseModel):
    ranges: dict[str, list[tuple[int, int]]]

# A stringified TextFileData object will be used to store the data of a text file to the database
class TextFileData(BaseModel):
    content: str = Field(default='')
    properties: dict[str, BasicPropertyRange | FlaggedPropertyRange] = Field(default={})

# TextFile is a child of the File class designed to make objects with attributes and methods helpful to a text file
class TextFile(File):
    data: TextFileData

    modifications: dict[int, Modification] # Modifications is a queue used to store identifiable modifications done by users
    next_mod_id = 0
    first_mod_id = 0

    def __init__(self, id: int, name: str):
        super().__init__(Lock(), id, name, {}, 0)
        self.data = TextFileData()
        self.modifications = {}

    # Handles when a user wants to make a modification to the text file
    def modify(self, user: User, mod: Modification) -> int:
        mod.apply(user)
        self.modifications[self.next_mod_id] = mod

        self.next_mod_id += 1
        return self.next_mod_id - 1
    
    # Figures out the last modification that is still needed for synchronisation and deletes all the previous ones
    def recalculate_first_mod_id(self):
        new_first_mod_id = min(user.last_mod_id for user in self.users.values() if not user.read_only)
        # print(f"Pruning mod id {self.first_mod_id} to {new_first_mod_id - 1}")

        if new_first_mod_id != self.first_mod_id:
            for mod_id in range(self.first_mod_id, new_first_mod_id):
                del self.modifications[mod_id]

            self.first_mod_id = new_first_mod_id

    # Shifts every online user that is concurrently on the same text file's cursor positions relative to a change made by one of the users. Also shifts all property ranges
    def shift_all_fixed_points(self, shift: Callable[[int], int]):
        for user in self.users.values():
            user.position = shift(user.position)

        for name, prop in self.data.properties.items():
            match prop:
                case BasicPropertyRange() as prop:
                    prop.ranges = [(shift(start), shift(end)) for start, end in prop.ranges]

                case FlaggedPropertyRange() as prop:
                    for flag, ranges in prop.ranges.items():
                        prop.ranges[flag] = [(shift(start), shift(end)) for start, end in prop.ranges[flag]]

    # Removes property ranges that aren't helpful, e.g. when the start range is equal to the end range
    def remove_empty_property_ranges(self):
        for name, prop in list(self.data.properties.items()):
            match prop:
                case BasicPropertyRange() as prop:
                    prop.ranges = [range for range in prop.ranges if range[0] < range[1]]
                    if len(prop.ranges) == 0:
                        del self.data.properties[name]

                case FlaggedPropertyRange() as prop:
                    for flag in list(prop.ranges.keys()):
                        prop.ranges[flag] = [range for range in prop.ranges[flag] if range[0] < range[1]]
                        if prop.ranges[flag] == []:
                            del prop.ranges[flag]

                    if len(prop.ranges) == 0:
                        del self.data.properties[name]
    
    # Gets all of the modifications that need to be applied to a user's text file content in order for it to be synchronised with the server's text file contnet
    def get_modifications_for(self, user: User) -> Generator[Modification, None, None]:
        # print(f"Getting mod ids {user.last_mod_id + 1} to {self.next_mod_id - 1}")
        for mod_id in range(user.last_mod_id + 1, self.next_mod_id):
            mod = self.modifications[mod_id]
            # Modifications by the use itself will already have been applied on the client side
            if mod.userid != user.id:
                yield self.modifications[mod_id]

    # Removes content from a text file while making sure that modifications that haven't reached the user yet are taken into account
    def remove(self, user: User, start: int, end: int) -> tuple[int, RemoveModification]:
        for mod in self.get_modifications_for(user):
            match mod:
                case AddModification() as mod:
                    if mod.position < start:
                        start += len(mod.text)
                    if mod.position <= end:
                        end += len(mod.text)
                case RemoveModification() as mod:
                    if mod.start < start:
                        start -= min(mod.end, start) - mod.start
                    if mod.start < end:
                        end -= min(mod.end, end) - mod.start

        remove = RemoveModification(user.id, start, end)
        return (self.modify(user, remove), remove)

    # Adds content to a text file while making sure that modifications that haven't reached the user yet are taken into account
    def add(self, user: User, text: str, position: int) -> tuple[int, AddModification]:
        for mod in self.get_modifications_for(user):
            match mod:
                case AddModification() as mod:
                    if mod.position < position:
                        position += len(mod.text)
                case RemoveModification() as mod:
                    if mod.start <= position:
                        position -= min(mod.end, position) - mod.start

        add = AddModification(user.id, text, position)
        return (self.modify(user, add), add)

    # Removes properties from a text file while making sure that modifications that haven't reached the user yet are taken into account
    def remove_property(self, user: User, start: int, end: int, property: str) -> tuple[int, RemovePropertyModification]:
        for mod in self.get_modifications_for(user):
            match mod:
                case AddModification() as mod:
                    if mod.position < start:
                        start += len(mod.text)
                    if mod.position <= end:
                        end += len(mod.text)
                case RemoveModification() as mod:
                    if mod.start < start:
                        start -= min(mod.end, start) - mod.start
                    if mod.start < end:
                        end -= min(mod.end, end) - mod.start

        remove = RemovePropertyModification(user.id, start, end, property)
        return (self.modify(user, remove), remove)

    # Adds properties to a text file while making sure that modifications that haven't reached the user yet are taken into account
    def add_property(self, user: User, start: int, end: int, property: str, flag: str | None) -> tuple[int, AddPropertyModification]:
        for mod in self.get_modifications_for(user):
            match mod:
                case AddModification() as mod:
                    if mod.position < start:
                        start += len(mod.text)
                    if mod.position <= end:
                        end += len(mod.text)
                case RemoveModification() as mod:
                    if mod.start < start:
                        start -= min(mod.end, start) - mod.start
                    if mod.start < end:
                        end -= min(mod.end, end) - mod.start

        add = AddPropertyModification(user.id, start, end, property, flag)
        return (self.modify(user, add), add)

    # Moves a users cursor while making sure that modifications that haven't reached the user yet are taken into account
    def move_cursor(self, user: User, position: int) -> int:
        for mod in self.get_modifications_for(user):
            match mod:
                case AddModification() as mod:
                    if mod.position < position:
                        position += len(mod.text)
                case RemoveModification() as mod:
                    if mod.start <= position:
                        position -= min(mod.end, position) - mod.start

        move = CursorModification(user.id, position)
        return (self.modify(user, move), move)

    # Returns text file's data in a serialized form which is ready to be stored in a database
    def stringify(self) -> str:
        return self.data.model_dump_json()

    # Turns a serialized string of text file data into an object thats ready to be interpreted by the code
    def parse(self, content: str):
        self.data = TextFileData.model_validate_json(content)
