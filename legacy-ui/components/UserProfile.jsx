import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import {
  X,
  Users,
  Search,
  Bell,
  Lock,
  Image as ImageIcon,
  File,
  Link,
  Star,
  Trash,
  UserPlus,
  UserMinus,
  Crown,
  Shield
} from 'lucide-react';

const UserProfile = ({ chat, onClose }) => {
  const [activeTab, setActiveTab] = useState('info');
  const { user } = useAuth();

  const mockMembers = [
    { id: 1, name: 'Alice Johnson', role: 'admin', online: true, avatar: null },
    { id: 2, name: 'Bob Smith', role: 'member', online: false, avatar: null },
    { id: 3, name: 'Charlie Brown', role: 'member', online: true, avatar: null },
    { id: 4, name: user?.username, role: 'member', online: true, avatar: null }
  ];

  const mockMedia = [
    { id: 1, type: 'image', url: 'https://via.placeholder.com/150', date: '2024-01-15' },
    { id: 2, type: 'image', url: 'https://via.placeholder.com/150', date: '2024-01-14' },
    { id: 3, type: 'file', name: 'document.pdf', size: '2.5 MB', date: '2024-01-13' },
    { id: 4, type: 'image', url: 'https://via.placeholder.com/150', date: '2024-01-12' }
  ];

  const tabs = [
    { id: 'info', label: 'Info', icon: Users },
    { id: 'media', label: 'Media', icon: ImageIcon },
    { id: 'files', label: 'Files', icon: File },
    { id: 'links', label: 'Links', icon: Link }
  ];

  const renderTabContent = () => {
    switch (activeTab) {
      case 'info':
        return (
          <div className="space-y-6">
            {/* Group Description */}
            <div>
              <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">
                Description
              </h3>
              <p className="text-gray-900 dark:text-white">
                {chat?.type === 'group' 
                  ? 'A friendly group chat for everyone to connect and share ideas.'
                  : 'Available for chat'
                }
              </p>
            </div>

            {/* Members */}
            {chat?.type === 'group' && (
              <div>
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">
                    Members ({mockMembers.length})
                  </h3>
                  <button className="text-green-600 dark:text-green-400 hover:underline text-sm">
                    <UserPlus className="w-4 h-4 inline mr-1" />
                    Add Member
                  </button>
                </div>
                
                <div className="space-y-3">
                  {mockMembers.map((member) => (
                    <div key={member.id} className="flex items-center justify-between">
                      <div className="flex items-center space-x-3">
                        <div className="relative">
                          <div className="w-10 h-10 bg-gray-300 dark:bg-gray-600 rounded-full flex items-center justify-center">
                            <span className="text-gray-700 dark:text-gray-300 font-semibold">
                              {member.name.charAt(0).toUpperCase()}
                            </span>
                          </div>
                          {member.online && (
                            <div className="absolute bottom-0 right-0 w-3 h-3 bg-green-400 border-2 border-white dark:border-gray-800 rounded-full"></div>
                          )}
                        </div>
                        <div>
                          <p className="font-medium text-gray-900 dark:text-white">
                            {member.name}
                            {member.name === user?.username && ' (You)'}
                          </p>
                          <div className="flex items-center space-x-2">
                            {member.role === 'admin' && (
                              <Crown className="w-3 h-3 text-yellow-500" />
                            )}
                            <span className="text-sm text-gray-500 dark:text-gray-400 capitalize">
                              {member.role}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Settings */}
            <div className="space-y-3">
              <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">
                Settings
              </h3>
              
              <button className="w-full flex items-center justify-between p-3 hover:bg-gray-50 dark:hover:bg-gray-700 rounded-lg transition-colors">
                <div className="flex items-center space-x-3">
                  <Bell className="w-5 h-5 text-gray-500 dark:text-gray-400" />
                  <span className="text-gray-900 dark:text-white">Notifications</span>
                </div>
                <span className="text-sm text-gray-500 dark:text-gray-400">On</span>
              </button>
              
              <button className="w-full flex items-center justify-between p-3 hover:bg-gray-50 dark:hover:bg-gray-700 rounded-lg transition-colors">
                <div className="flex items-center space-x-3">
                  <Lock className="w-5 h-5 text-gray-500 dark:text-gray-400" />
                  <span className="text-gray-900 dark:text-white">Disappearing Messages</span>
                </div>
                <span className="text-sm text-gray-500 dark:text-gray-400">Off</span>
              </button>
              
              <button className="w-full flex items-center justify-between p-3 hover:bg-gray-50 dark:hover:bg-gray-700 rounded-lg transition-colors">
                <div className="flex items-center space-x-3">
                  <Star className="w-5 h-5 text-gray-500 dark:text-gray-400" />
                  <span className="text-gray-900 dark:text-white">Starred Messages</span>
                </div>
                <span className="text-sm text-gray-500 dark:text-gray-400">3</span>
              </button>
            </div>

            {/* Danger Zone */}
            <div className="space-y-3 pt-4 border-t border-gray-200 dark:border-gray-700">
              <button className="w-full flex items-center space-x-3 p-3 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors text-red-600 dark:text-red-400">
                <Trash className="w-5 h-5" />
                <span>Delete Chat</span>
              </button>
              
              {chat?.type === 'group' && (
                <button className="w-full flex items-center space-x-3 p-3 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors text-red-600 dark:text-red-400">
                  <UserMinus className="w-5 h-5" />
                  <span>Leave Group</span>
                </button>
              )}
            </div>
          </div>
        );

      case 'media':
        return (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">
                Photos & Videos
              </h3>
              <button className="text-green-600 dark:text-green-400 hover:underline text-sm">
                View All
              </button>
            </div>
            
            <div className="grid grid-cols-3 gap-2">
              {mockMedia.filter(item => item.type === 'image').map((item) => (
                <div key={item.id} className="aspect-square bg-gray-200 dark:bg-gray-700 rounded-lg overflow-hidden cursor-pointer hover:opacity-80 transition-opacity">
                  <img
                    src={item.url}
                    alt="Shared media"
                    className="w-full h-full object-cover"
                  />
                </div>
              ))}
            </div>
          </div>
        );

      case 'files':
        return (
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">
              Documents
            </h3>
            
            <div className="space-y-3">
              {mockMedia.filter(item => item.type === 'file').map((item) => (
                <div key={item.id} className="flex items-center space-x-3 p-3 hover:bg-gray-50 dark:hover:bg-gray-700 rounded-lg cursor-pointer transition-colors">
                  <div className="p-2 bg-blue-500 rounded-full">
                    <File className="w-4 h-4 text-white" />
                  </div>
                  <div className="flex-1">
                    <p className="font-medium text-gray-900 dark:text-white text-sm">
                      {item.name}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {item.size} • {item.date}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );

      case 'links':
        return (
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">
              Shared Links
            </h3>
            
            <div className="text-center py-8">
              <Link className="w-12 h-12 text-gray-400 mx-auto mb-3" />
              <p className="text-gray-500 dark:text-gray-400">No links shared yet</p>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-800">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
          {chat?.type === 'group' ? 'Group Info' : 'Contact Info'}
        </h2>
        <button
          onClick={onClose}
          className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-full transition-colors"
        >
          <X className="w-5 h-5 text-gray-500 dark:text-gray-400" />
        </button>
      </div>

      {/* Profile Section */}
      <div className="px-4 py-6 text-center border-b border-gray-200 dark:border-gray-700">
        <div className="w-24 h-24 bg-gray-300 dark:bg-gray-600 rounded-full mx-auto mb-4 flex items-center justify-center">
          {chat?.type === 'group' ? (
            <Users className="w-12 h-12 text-gray-600 dark:text-gray-400" />
          ) : (
            <span className="text-2xl font-semibold text-gray-700 dark:text-gray-300">
              {chat?.name?.charAt(0).toUpperCase()}
            </span>
          )}
        </div>
        <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-1">
          {chat?.name}
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {chat?.type === 'group' ? `Group • ${mockMembers.length} members` : 'last seen recently'}
        </p>
        
        {/* Action Buttons */}
        <div className="flex justify-center space-x-4 mt-4">
          <button className="p-3 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 rounded-full hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors">
            <Search className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200 dark:border-gray-700">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? 'text-green-600 dark:text-green-400 border-b-2 border-green-600 dark:border-green-400'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
              }`}
            >
              <Icon className="w-4 h-4 mx-auto mb-1" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {renderTabContent()}
      </div>
    </div>
  );
};

export default UserProfile;