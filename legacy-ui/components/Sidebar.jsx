import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useSocket } from '../context/SocketContext';
import {
  MessageCircle,
  MoreVertical,
  Search,
  Plus,
  Settings,
  Moon,
  Sun,
  LogOut,
  Users,
  UserPlus,
  Archive,
  Star,
  Bell,
  BellOff,
  Pin,
  Trash,
  Edit,
  CheckCircle,
  Circle,
  Camera,
  Mic,
  Image,
  File,
  Smile
} from 'lucide-react';

const Sidebar = ({ chats, selectedChat, onChatSelect, onNewChat, onProfileClick }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [showMenu, setShowMenu] = useState(false);
  const [showAddContactModal, setShowAddContactModal] = useState(false);
  const [showCreateGroupModal, setShowCreateGroupModal] = useState(false);
  const [newContactUsername, setNewContactUsername] = useState('');
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupDescription, setNewGroupDescription] = useState('');
  const [selectedMembers, setSelectedMembers] = useState([]);
  const [activeTab, setActiveTab] = useState('chats'); // chats, contacts, groups, archived
  const [showStatus, setShowStatus] = useState(false);
  
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { onlineUsers, contacts, groups, addContact, createGroup, notifications } = useSocket();

  // Combine all chats (contacts + groups)
  const allChats = [
    ...contacts.map(contact => ({
      id: contact.username,
      name: contact.username,
      type: 'contact',
      lastMessage: contact.lastMessage || 'Tap to start chatting',
      lastMessageTime: contact.lastMessageTime || new Date().toISOString(),
      unreadCount: contact.unreadCount || 0,
      avatar: contact.avatar,
      status: contact.status,
      lastSeen: contact.lastSeen,
      isOnline: onlineUsers.includes(contact.username)
    })),
    ...groups.map(group => ({
      id: group.id,
      name: group.name,
      type: 'group',
      lastMessage: group.lastMessage || 'Group created',
      lastMessageTime: group.lastMessageTime || group.createdAt,
      unreadCount: group.unreadCount || 0,
      avatar: group.avatar,
      members: group.members,
      description: group.description
    }))
  ];

  const filteredChats = allChats.filter(chat =>
    chat.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const archivedChats = allChats.filter(chat => chat.archived);
  const pinnedChats = allChats.filter(chat => chat.pinned);
  const regularChats = allChats.filter(chat => !chat.archived && !chat.pinned);

  const formatTime = (timestamp) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffInHours = (now - date) / (1000 * 60 * 60);

    if (diffInHours < 1) {
      return 'now';
    } else if (diffInHours < 24) {
      return date.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      });
    } else if (diffInHours < 168) { // 7 days
      return date.toLocaleDateString('en-US', { weekday: 'short' });
    } else {
      return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric'
      });
    }
  };

  const handleAddContact = async () => {
    if (newContactUsername.trim()) {
      const result = await addContact(newContactUsername.trim());
      if (result.success) {
        setNewContactUsername('');
        setShowAddContactModal(false);
        // Auto-select the new contact
        onChatSelect({
          id: result.contact.username,
          name: result.contact.username,
          type: 'contact'
        });
      } else {
        alert(result.error || 'Failed to add contact');
      }
    }
  };

  const handleCreateGroup = async () => {
    if (newGroupName.trim()) {
      const result = await createGroup(
        newGroupName.trim(),
        newGroupDescription.trim(),
        selectedMembers
      );
      if (result.success) {
        setNewGroupName('');
        setNewGroupDescription('');
        setSelectedMembers([]);
        setShowCreateGroupModal(false);
        // Auto-select the new group
        onChatSelect({
          id: result.group.id,
          name: result.group.name,
          type: 'group'
        });
      } else {
        alert(result.error || 'Failed to create group');
      }
    }
  };

  const renderChatItem = (chat) => (
    <div
      key={chat.id}
      onClick={() => onChatSelect(chat)}
      className={`px-4 py-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors relative ${
        selectedChat?.id === chat.id ? 'bg-green-50 dark:bg-green-900/20 border-r-2 border-green-500' : ''
      }`}
    >
      <div className="flex items-center space-x-3">
        <div className="relative">
          <div className="w-12 h-12 bg-gray-300 dark:bg-gray-600 rounded-full flex items-center justify-center overflow-hidden">
            {chat.avatar ? (
              <img src={chat.avatar} alt={chat.name} className="w-full h-full object-cover" />
            ) : chat.type === 'group' ? (
              <Users className="w-6 h-6 text-gray-600 dark:text-gray-400" />
            ) : (
              <span className="text-gray-700 dark:text-gray-300 font-semibold">
                {chat.name.charAt(0).toUpperCase()}
              </span>
            )}
          </div>
          
          {/* Online indicator for contacts */}
          {chat.type === 'contact' && chat.isOnline && (
            <div className="absolute bottom-0 right-0 w-3 h-3 bg-green-400 border-2 border-white dark:border-gray-800 rounded-full"></div>
          )}
          
          {/* Unread count */}
          {chat.unreadCount > 0 && (
            <div className="absolute -top-1 -right-1 w-5 h-5 bg-green-500 rounded-full flex items-center justify-center">
              <span className="text-white text-xs font-medium">
                {chat.unreadCount > 99 ? '99+' : chat.unreadCount}
              </span>
            </div>
          )}

          {/* Pinned indicator */}
          {chat.pinned && (
            <Pin className="absolute -top-1 -left-1 w-3 h-3 text-gray-500" />
          )}
        </div>
        
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <h3 className="font-medium text-gray-900 dark:text-white truncate flex items-center space-x-2">
              <span>{chat.name}</span>
              {chat.type === 'group' && chat.muted && (
                <BellOff className="w-3 h-3 text-gray-400" />
              )}
            </h3>
            <div className="flex items-center space-x-1">
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {formatTime(chat.lastMessageTime)}
              </span>
              {chat.type === 'contact' && chat.status === 'typing' && (
                <div className="flex space-x-1">
                  <div className="w-1 h-1 bg-green-500 rounded-full animate-bounce"></div>
                  <div className="w-1 h-1 bg-green-500 rounded-full animate-bounce delay-100"></div>
                  <div className="w-1 h-1 bg-green-500 rounded-full animate-bounce delay-200"></div>
                </div>
              )}
            </div>
          </div>
          
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-600 dark:text-gray-400 truncate">
              {chat.type === 'group' && chat.lastMessageSender && (
                <span className="text-green-600 dark:text-green-400">
                  {chat.lastMessageSender === user.username ? 'You: ' : `${chat.lastMessageSender}: `}
                </span>
              )}
              {chat.lastMessage}
            </p>
            
            <div className="flex items-center space-x-1">
              {/* Message status indicators */}
              {chat.lastMessageStatus === 'sent' && (
                <CheckCircle className="w-3 h-3 text-gray-400" />
              )}
              {chat.lastMessageStatus === 'delivered' && (
                <CheckCircle className="w-3 h-3 text-blue-400" />
              )}
              {chat.lastMessageStatus === 'read' && (
                <CheckCircle className="w-3 h-3 text-green-400" />
              )}
              
              {/* Chat actions */}
              {chat.muted && (
                <BellOff className="w-3 h-3 text-gray-400" />
              )}
            </div>
          </div>
          
          {/* Contact status */}
          {chat.type === 'contact' && !chat.isOnline && chat.lastSeen && (
            <p className="text-xs text-gray-400">
              Last seen {formatTime(chat.lastSeen)}
            </p>
          )}
          
          {/* Group member count */}
          {chat.type === 'group' && (
            <p className="text-xs text-gray-400">
              {chat.members?.length || 0} members
            </p>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-800">
      {/* Header */}
      <div className="px-4 py-3 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div
              onClick={onProfileClick}
              className="w-10 h-10 bg-green-500 rounded-full flex items-center justify-center cursor-pointer hover:bg-green-600 transition-colors relative overflow-hidden"
            >
              {user?.avatar ? (
                <img src={user.avatar} alt={user.username} className="w-full h-full object-cover" />
              ) : (
                <span className="text-white font-semibold">
                  {user?.username?.charAt(0).toUpperCase()}
                </span>
              )}
            </div>
            <div>
              <span className="font-semibold text-gray-900 dark:text-white">
                {user?.username}
              </span>
              <div className="flex items-center space-x-1">
                <div className="w-2 h-2 bg-green-400 rounded-full"></div>
                <span className="text-xs text-gray-500 dark:text-gray-400">Online</span>
              </div>
            </div>
          </div>
          
          <div className="flex items-center space-x-2">
            {/* Status button */}
            <button
              onClick={() => setShowStatus(true)}
              className="p-2 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-full transition-colors"
              title="Status"
            >
              <Circle className="w-5 h-5 text-gray-600 dark:text-gray-400" />
            </button>
            
            {/* New chat button */}
            <button
              onClick={() => setShowAddContactModal(true)}
              className="p-2 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-full transition-colors"
              title="New Chat"
            >
              <MessageCircle className="w-5 h-5 text-gray-600 dark:text-gray-400" />
            </button>
            
            {/* Menu button */}
            <div className="relative">
              <button
                onClick={() => setShowMenu(!showMenu)}
                className="p-2 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-full transition-colors"
              >
                <MoreVertical className="w-5 h-5 text-gray-600 dark:text-gray-400" />
              </button>
              
              {showMenu && (
                <div className="absolute right-0 top-full mt-1 w-56 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 z-10">
                  <button
                    onClick={() => {
                      setShowCreateGroupModal(true);
                      setShowMenu(false);
                    }}
                    className="w-full px-4 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 flex items-center space-x-2"
                  >
                    <Users className="w-4 h-4" />
                    <span>New Group</span>
                  </button>
                  <button
                    onClick={() => {
                      setShowAddContactModal(true);
                      setShowMenu(false);
                    }}
                    className="w-full px-4 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 flex items-center space-x-2"
                  >
                    <UserPlus className="w-4 h-4" />
                    <span>Add Contact</span>
                  </button>
                  <hr className="border-gray-200 dark:border-gray-700" />
                  <button
                    onClick={() => {
                      setActiveTab('archived');
                      setShowMenu(false);
                    }}
                    className="w-full px-4 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 flex items-center space-x-2"
                  >
                    <Archive className="w-4 h-4" />
                    <span>Archived</span>
                  </button>
                  <button
                    onClick={() => {
                      setActiveTab('starred');
                      setShowMenu(false);
                    }}
                    className="w-full px-4 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 flex items-center space-x-2"
                  >
                    <Star className="w-4 h-4" />
                    <span>Starred</span>
                  </button>
                  <hr className="border-gray-200 dark:border-gray-700" />
                  <button
                    onClick={() => {
                      toggleTheme();
                      setShowMenu(false);
                    }}
                    className="w-full px-4 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 flex items-center space-x-2"
                  >
                    {theme === 'light' ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
                    <span>{theme === 'light' ? 'Dark Mode' : 'Light Mode'}</span>
                  </button>
                  <button
                    onClick={() => setShowMenu(false)}
                    className="w-full px-4 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 flex items-center space-x-2"
                  >
                    <Settings className="w-4 h-4" />
                    <span>Settings</span>
                  </button>
                  <hr className="border-gray-200 dark:border-gray-700" />
                  <button
                    onClick={() => {
                      logout();
                      setShowMenu(false);
                    }}
                    className="w-full px-4 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700 text-red-600 dark:text-red-400 flex items-center space-x-2"
                  >
                    <LogOut className="w-4 h-4" />
                    <span>Logout</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Notifications Bar */}
      {notifications.length > 0 && (
        <div className="px-4 py-2 bg-blue-50 dark:bg-blue-900/20 border-b border-blue-200 dark:border-blue-800">
          <div className="flex items-center space-x-2">
            <Bell className="w-4 h-4 text-blue-600 dark:text-blue-400" />
            <span className="text-sm text-blue-600 dark:text-blue-400">
              {notifications[0].message}
            </span>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        {[
          { id: 'chats', label: 'Chats', count: allChats.length },
          { id: 'contacts', label: 'Contacts', count: contacts.length },
          { id: 'groups', label: 'Groups', count: groups.length },
          { id: 'archived', label: 'Archived', count: archivedChats.length }
        ].map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
              activeTab === tab.id
                ? 'text-green-600 dark:text-green-400 border-b-2 border-green-600 dark:border-green-400 bg-white dark:bg-gray-800'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
            }`}
          >
            {tab.label}
            {tab.count > 0 && (
              <span className="ml-1 px-2 py-0.5 text-xs bg-gray-200 dark:bg-gray-600 rounded-full">
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="px-4 py-3">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder={`Search ${activeTab}...`}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 transition-all"
          />
        </div>
      </div>

      {/* Online Users (for contacts tab) */}
      {activeTab === 'contacts' && onlineUsers.length > 0 && (
        <div className="px-4 pb-2">
          <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
            Online Now ({onlineUsers.length})
          </h3>
          <div className="flex space-x-2 overflow-x-auto">
            {onlineUsers.map((username, index) => (
              <div key={index} className="flex-shrink-0 text-center">
                <div className="w-12 h-12 bg-green-500 rounded-full flex items-center justify-center relative cursor-pointer hover:bg-green-600 transition-colors">
                  <span className="text-white font-semibold text-sm">
                    {username.charAt(0).toUpperCase()}
                  </span>
                  <div className="absolute bottom-0 right-0 w-3 h-3 bg-green-400 border-2 border-white dark:border-gray-800 rounded-full"></div>
                </div>
                <p className="text-xs text-gray-600 dark:text-gray-400 mt-1 truncate w-12">
                  {username}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Chat List */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'chats' && (
          <div>
            {/* Pinned Chats */}
            {pinnedChats.length > 0 && (
              <div>
                <div className="px-4 py-2 bg-gray-50 dark:bg-gray-800">
                  <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                    Pinned
                  </h3>
                </div>
                {pinnedChats.map(renderChatItem)}
              </div>
            )}
            
            {/* Regular Chats */}
            {regularChats.length > 0 ? (
              regularChats
                .filter(chat => chat.name.toLowerCase().includes(searchQuery.toLowerCase()))
                .map(renderChatItem)
            ) : (
              <div className="px-4 py-8 text-center">
                <MessageCircle className="w-12 h-12 text-gray-400 mx-auto mb-3" />
                <p className="text-gray-500 dark:text-gray-400">No chats yet</p>
                <button
                  onClick={() => setShowAddContactModal(true)}
                  className="mt-2 text-green-600 dark:text-green-400 hover:underline"
                >
                  Start a new conversation
                </button>
              </div>
            )}
          </div>
        )}

        {activeTab === 'contacts' && (
          <div className="space-y-1">
            {contacts.length > 0 ? (
              contacts
                .filter(contact => contact.username.toLowerCase().includes(searchQuery.toLowerCase()))
                .map(contact => renderChatItem({
                  id: contact.username,
                  name: contact.username,
                  type: 'contact',
                  lastMessage: contact.lastMessage || 'Tap to chat',
                  lastMessageTime: contact.lastMessageTime || contact.createdAt,
                  unreadCount: contact.unreadCount || 0,
                  avatar: contact.avatar,
                  isOnline: onlineUsers.includes(contact.username),
                  status: contact.status,
                  lastSeen: contact.lastSeen
                }))
            ) : (
              <div className="px-4 py-8 text-center">
                <UserPlus className="w-12 h-12 text-gray-400 mx-auto mb-3" />
                <p className="text-gray-500 dark:text-gray-400">No contacts yet</p>
                <button
                  onClick={() => setShowAddContactModal(true)}
                  className="mt-2 text-green-600 dark:text-green-400 hover:underline"
                >
                  Add your first contact
                </button>
              </div>
            )}
          </div>
        )}

        {activeTab === 'groups' && (
          <div className="space-y-1">
            {groups.length > 0 ? (
              groups
                .filter(group => group.name.toLowerCase().includes(searchQuery.toLowerCase()))
                .map(group => renderChatItem({
                  id: group.id,
                  name: group.name,
                  type: 'group',
                  lastMessage: group.lastMessage || 'Group created',
                  lastMessageTime: group.lastMessageTime || group.createdAt,
                  unreadCount: group.unreadCount || 0,
                  avatar: group.avatar,
                  members: group.members,
                  description: group.description
                }))
            ) : (
              <div className="px-4 py-8 text-center">
                <Users className="w-12 h-12 text-gray-400 mx-auto mb-3" />
                <p className="text-gray-500 dark:text-gray-400">No groups yet</p>
                <button
                  onClick={() => setShowCreateGroupModal(true)}
                  className="mt-2 text-green-600 dark:text-green-400 hover:underline"
                >
                  Create your first group
                </button>
              </div>
            )}
          </div>
        )}

        {activeTab === 'archived' && (
          <div className="space-y-1">
            {archivedChats.length > 0 ? (
              archivedChats
                .filter(chat => chat.name.toLowerCase().includes(searchQuery.toLowerCase()))
                .map(renderChatItem)
            ) : (
              <div className="px-4 py-8 text-center">
                <Archive className="w-12 h-12 text-gray-400 mx-auto mb-3" />
                <p className="text-gray-500 dark:text-gray-400">No archived chats</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Add Contact Modal */}
      {showAddContactModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 w-80 max-w-90vw">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
              Add New Contact
            </h3>
            <input
              type="text"
              placeholder="Enter username"
              value={newContactUsername}
              onChange={(e) => setNewContactUsername(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-white mb-4"
              onKeyPress={(e) => e.key === 'Enter' && handleAddContact()}
              autoFocus
            />
            <div className="flex space-x-3">
              <button
                onClick={() => {
                  setShowAddContactModal(false);
                  setNewContactUsername('');
                }}
                className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleAddContact}
                disabled={!newContactUsername.trim()}
                className="flex-1 px-4 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
              >
                Add Contact
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Group Modal */}
      {showCreateGroupModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 w-96 max-w-90vw max-h-90vh overflow-y-auto">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
              Create New Group
            </h3>
            
            <div className="space-y-4">
              <input
                type="text"
                placeholder="Group name"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
              />
              
              <textarea
                placeholder="Group description (optional)"
                value={newGroupDescription}
                onChange={(e) => setNewGroupDescription(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-white resize-none"
                rows="3"
              />
              
              {/* Member Selection */}
              <div>
                <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Add Members
                </h4>
                <div className="max-h-40 overflow-y-auto space-y-2">
                  {contacts.map(contact => (
                    <label key={contact.username} className="flex items-center space-x-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedMembers.includes(contact.username)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedMembers(prev => [...prev, contact.username]);
                          } else {
                            setSelectedMembers(prev => prev.filter(m => m !== contact.username));
                          }
                        }}
                        className="rounded border-gray-300 text-green-600 focus:ring-green-500"
                      />
                      <div className="w-8 h-8 bg-gray-300 dark:bg-gray-600 rounded-full flex items-center justify-center">
                        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                          {contact.username.charAt(0).toUpperCase()}
                        </span>
                      </div>
                      <span className="text-sm text-gray-900 dark:text-white">
                        {contact.username}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
            
            <div className="flex space-x-3 mt-6">
              <button
                onClick={() => {
                  setShowCreateGroupModal(false);
                  setNewGroupName('');
                  setNewGroupDescription('');
                  setSelectedMembers([]);
                }}
                className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateGroup}
                disabled={!newGroupName.trim()}
                className="flex-1 px-4 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
              >
                Create Group
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Sidebar;