import React, { useState, useRef, useEffect } from 'react';
import { useSocket } from '../context/SocketContext';
import { useAuth } from '../context/AuthContext';
import MessageBubble from './MessageBubble';
import MessageInput from './MessageInput';
import {
  MoreVertical,
  Users,
  Search,
  Pin,
  Bell,
  BellOff,
  Archive,
  Trash,
  Star,
  X,
  ArrowLeft
} from 'lucide-react';

const ChatArea = ({ chat, onProfileClick, onBackClick }) => {
  const [showChatMenu, setShowChatMenu] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [chatSettings, setChatSettings] = useState({
    pinned: false,
    muted: false,
    archived: false,
    notifications: true
  });
  const messagesEndRef = useRef(null);
  
  const { messages, sendMessage, typingUsers } = useSocket();
  const { user } = useAuth();
  
  const chatMessages = messages[chat?.id] || [];
  const isTyping = typingUsers[chat?.id]?.length > 0;

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [chatMessages]);

  const handleSendMessage = (message, messageType = 'text', metadata = {}) => {
    if (chat && message.trim()) {
      sendMessage(chat.id, message, messageType, metadata);
    }
  };

  const handleMenuAction = async (action) => {
    setShowChatMenu(false);
    
    switch (action) {
      case 'pin':
        setChatSettings(prev => ({ ...prev, pinned: !prev.pinned }));
        // TODO: Send to backend
        break;
      case 'mute':
        setChatSettings(prev => ({ ...prev, muted: !prev.muted }));
        // TODO: Send to backend
        break;
      case 'archive':
        setChatSettings(prev => ({ ...prev, archived: !prev.archived }));
        // TODO: Send to backend
        break;
      case 'delete':
        if (confirm('Are you sure you want to delete this chat?')) {
          // TODO: Send to backend
          console.log('Deleting chat:', chat.id);
        }
        break;
      case 'block':
        if (confirm('Are you sure you want to block this contact?')) {
          // TODO: Send to backend
          console.log('Blocking contact:', chat.id);
        }
        break;
    }
  };

  const filteredMessages = chatMessages.filter(msg =>
    !searchQuery || msg.message.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (!chat) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="text-center">
          <div className="w-32 h-32 mx-auto mb-4 bg-gray-200 dark:bg-gray-700 rounded-full flex items-center justify-center">
            <span className="text-4xl">💬</span>
          </div>
          <h2 className="text-2xl font-semibold text-gray-800 dark:text-gray-200 mb-2">
            Chitthi
          </h2>
          <p className="text-gray-600 dark:text-gray-400 max-w-md">
            Send and receive messages without keeping your phone online.
            Select a chat to start messaging.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-800">
      {/* Chat Header */}
      <div className="px-4 py-3 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          {/* Back button for mobile */}
          <button
            onClick={onBackClick}
            className="p-2 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-full transition-colors md:hidden"
          >
            <ArrowLeft className="w-5 h-5 text-gray-600 dark:text-gray-400" />
          </button>

          <div
            onClick={onProfileClick}
            className="w-10 h-10 bg-gray-300 dark:bg-gray-600 rounded-full flex items-center justify-center cursor-pointer hover:bg-gray-400 dark:hover:bg-gray-500 transition-colors overflow-hidden"
          >
            {chat.avatar ? (
              <img src={chat.avatar} alt={chat.name} className="w-full h-full object-cover" />
            ) : chat.type === 'group' ? (
              <Users className="w-5 h-5 text-gray-600 dark:text-gray-400" />
            ) : (
              <span className="text-gray-700 dark:text-gray-300 font-semibold">
                {chat.name.charAt(0).toUpperCase()}
              </span>
            )}
          </div>
          
          <div className="flex-1 min-w-0">
            <div className="flex items-center space-x-2">
              <h2 className="font-semibold text-gray-900 dark:text-white truncate">
                {chat.name}
              </h2>
              {chatSettings.pinned && (
                <Pin className="w-3 h-3 text-gray-500 dark:text-gray-400" />
              )}
              {chatSettings.muted && (
                <BellOff className="w-3 h-3 text-gray-500 dark:text-gray-400" />
              )}
            </div>
            
            <div className="flex items-center space-x-2">
              {isTyping ? (
                <div className="flex items-center space-x-1 text-green-600 dark:text-green-400">
                  <span className="text-sm">typing</span>
                  <div className="flex space-x-1">
                    <div className="w-1 h-1 bg-green-500 rounded-full animate-bounce"></div>
                    <div className="w-1 h-1 bg-green-500 rounded-full animate-bounce delay-100"></div>
                    <div className="w-1 h-1 bg-green-500 rounded-full animate-bounce delay-200"></div>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {chat.type === 'group' 
                    ? `${chat.members?.length || 0} members`
                    : chat.isOnline 
                      ? 'online' 
                      : 'last seen recently'
                  }
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={() => setShowSearch(!showSearch)}
            className="p-2 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-full transition-colors"
            title="Search messages"
          >
            <Search className="w-5 h-5 text-gray-600 dark:text-gray-400" />
          </button>
          
          
          <div className="relative">
            <button
              onClick={() => setShowChatMenu(!showChatMenu)}
              className="p-2 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-full transition-colors"
            >
              <MoreVertical className="w-5 h-5 text-gray-600 dark:text-gray-400" />
            </button>
            
            {showChatMenu && (
              <div className="absolute right-0 top-full mt-1 w-48 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 z-20">
                <button
                  onClick={() => handleMenuAction('pin')}
                  className="w-full px-4 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 flex items-center space-x-2"
                >
                  <Pin className="w-4 h-4" />
                  <span>{chatSettings.pinned ? 'Unpin chat' : 'Pin chat'}</span>
                </button>
                
                <button
                  onClick={() => handleMenuAction('mute')}
                  className="w-full px-4 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 flex items-center space-x-2"
                >
                  {chatSettings.muted ? <Bell className="w-4 h-4" /> : <BellOff className="w-4 h-4" />}
                  <span>{chatSettings.muted ? 'Unmute notifications' : 'Mute notifications'}</span>
                </button>
                
                <button
                  onClick={() => handleMenuAction('archive')}
                  className="w-full px-4 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 flex items-center space-x-2"
                >
                  <Archive className="w-4 h-4" />
                  <span>{chatSettings.archived ? 'Unarchive chat' : 'Archive chat'}</span>
                </button>
                
                <hr className="border-gray-200 dark:border-gray-700" />
                
                <button
                  onClick={onProfileClick}
                  className="w-full px-4 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 flex items-center space-x-2"
                >
                  <Users className="w-4 h-4" />
                  <span>{chat.type === 'group' ? 'Group info' : 'Contact info'}</span>
                </button>
                
                <button
                  onClick={() => handleMenuAction('star')}
                  className="w-full px-4 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 flex items-center space-x-2"
                >
                  <Star className="w-4 h-4" />
                  <span>Starred messages</span>
                </button>
                
                <hr className="border-gray-200 dark:border-gray-700" />
                
                {chat.type === 'contact' && (
                  <button
                    onClick={() => handleMenuAction('block')}
                    className="w-full px-4 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700 text-red-600 dark:text-red-400 flex items-center space-x-2"
                  >
                    <X className="w-4 h-4" />
                    <span>Block contact</span>
                  </button>
                )}
                
                <button
                  onClick={() => handleMenuAction('delete')}
                  className="w-full px-4 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700 text-red-600 dark:text-red-400 flex items-center space-x-2"
                >
                  <Trash className="w-4 h-4" />
                  <span>Delete chat</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Search Bar */}
      {showSearch && (
        <div className="px-4 py-2 bg-yellow-50 dark:bg-yellow-900/20 border-b border-yellow-200 dark:border-yellow-800">
          <div className="flex items-center space-x-2">
            <input
              type="text"
              placeholder="Search messages..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="flex-1 px-3 py-1 bg-white dark:bg-gray-700 border border-yellow-300 dark:border-yellow-600 rounded text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-yellow-500"
              autoFocus
            />
            <button
              onClick={() => {
                setShowSearch(false);
                setSearchQuery('');
              }}
              className="p-1 hover:bg-yellow-200 dark:hover:bg-yellow-800 rounded"
            >
              <X className="w-4 h-4 text-yellow-600 dark:text-yellow-400" />
            </button>
          </div>
          {searchQuery && (
            <p className="text-xs text-yellow-600 dark:text-yellow-400 mt-1">
              {filteredMessages.length} message(s) found
            </p>
          )}
        </div>
      )}

      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto p-4 bg-gray-50 dark:bg-gray-900 bg-opacity-50 chat-background">
        <div className="space-y-3">
          {filteredMessages.length === 0 ? (
            <div className="text-center py-8">
              <div className="w-20 h-20 mx-auto mb-4 bg-gray-200 dark:bg-gray-700 rounded-full flex items-center justify-center">
                <span className="text-2xl">👋</span>
              </div>
              <p className="text-gray-500 dark:text-gray-400">
                {searchQuery ? 'No messages found' : `Start chatting with ${chat.name}`}
              </p>
              {!searchQuery && (
                <p className="text-sm text-gray-400 dark:text-gray-500 mt-2">
                  Messages are not end-to-end encrypted: the server can read them.
                </p>
              )}
            </div>
          ) : (
            filteredMessages.map((message, index) => (
              <MessageBubble
                key={message.id || index}
                message={message}
                isOwn={message.sender === user?.username}
                showSender={chat.type === 'group'}
                searchQuery={searchQuery}
              />
            ))
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Message Input */}
      <MessageInput
        chat={chat}
        onSendMessage={handleSendMessage}
        disabled={!chat}
      />
    </div>
  );
};

export default ChatArea;