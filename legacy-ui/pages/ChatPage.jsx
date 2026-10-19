import React, { useState, useEffect } from 'react';
import Sidebar from '../components/Sidebar';
import ChatArea from '../components/ChatArea';
import UserProfile from '../components/UserProfile';
import { useSocket } from '../context/SocketContext';

const ChatPage = () => {
  const [selectedChat, setSelectedChat] = useState(null);
  const [showProfile, setShowProfile] = useState(false);
  const [chats, setChats] = useState([
    {
      id: 'general',
      name: 'General',
      type: 'group',
      lastMessage: 'Welcome to the general chat!',
      lastMessageTime: new Date().toISOString(),
      unreadCount: 0,
      avatar: null
    }
  ]);
  const { joinRoom } = useSocket();

  useEffect(() => {
    // Auto-select general chat on first load
    if (!selectedChat && chats.length > 0) {
      setSelectedChat(chats[0]);
      joinRoom(chats[0].id);
    }
  }, [chats, selectedChat, joinRoom]);

  const handleChatSelect = (chat) => {
    if (selectedChat) {
      // Leave previous room
    }
    setSelectedChat(chat);
    joinRoom(chat.id);
    setShowProfile(false);
  };

  const handleNewChat = (chatData) => {
    setChats(prev => [chatData, ...prev]);
  };

  return (
    <div className="flex h-screen bg-gray-100 dark:bg-gray-900">
      {/* Sidebar */}
      <div className="w-80 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700">
        <Sidebar
          chats={chats}
          selectedChat={selectedChat}
          onChatSelect={handleChatSelect}
          onNewChat={handleNewChat}
          onProfileClick={() => setShowProfile(true)}
        />
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col">
        {selectedChat ? (
          <ChatArea
            chat={selectedChat}
            onProfileClick={() => setShowProfile(true)}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center bg-gray-50 dark:bg-gray-900">
            <div className="text-center">
              <div className="w-32 h-32 mx-auto mb-4 bg-gray-200 dark:bg-gray-700 rounded-full flex items-center justify-center">
                <span className="text-4xl">💬</span>
              </div>
              <h2 className="text-2xl font-semibold text-gray-800 dark:text-gray-200 mb-2">
                Chitthi
              </h2>
              <p className="text-gray-600 dark:text-gray-400 max-w-md">
                Select a conversation to start.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* User Profile Sidebar */}
      {showProfile && (
        <div className="w-80 bg-white dark:bg-gray-800 border-l border-gray-200 dark:border-gray-700">
          <UserProfile
            chat={selectedChat}
            onClose={() => setShowProfile(false)}
          />
        </div>
      )}
    </div>
  );
};

export default ChatPage;