import React, { useState } from 'react';
import { 
  Download, 
  Play, 
  Pause, 
  Volume2, 
  FileText,
  Image as ImageIcon,
  Check,
  CheckCheck,
  MoreVertical,
  Reply,
  Copy,
  Trash
} from 'lucide-react';

const MessageBubble = ({ message, isOwn, showSender }) => {
  const [showMenu, setShowMenu] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);

  const formatTime = (timestamp) => {
    return new Date(timestamp).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  };

  const handleCopyMessage = () => {
    navigator.clipboard.writeText(message.message);
    setShowMenu(false);
  };

  const renderMessageContent = () => {
    switch (message.messageType) {
      case 'image':
        return (
          <div className="relative">
            <img
              src={message.message}
              alt="Shared image"
              className="max-w-xs rounded-lg cursor-pointer hover:opacity-90 transition-opacity"
              onClick={() => window.open(message.message, '_blank')}
            />
            <div className="absolute top-2 right-2 bg-black bg-opacity-50 rounded-full p-1">
              <ImageIcon className="w-4 h-4 text-white" />
            </div>
          </div>
        );

      case 'file':
        return (
          <div className="flex items-center space-x-3 p-3 bg-gray-100 dark:bg-gray-700 rounded-lg max-w-xs">
            <div className="p-2 bg-blue-500 rounded-full">
              <FileText className="w-5 h-5 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium text-gray-900 dark:text-white truncate">
                {message.fileName || 'File'}
              </p>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {message.fileSize || 'Unknown size'}
              </p>
            </div>
            <button className="p-1 hover:bg-gray-200 dark:hover:bg-gray-600 rounded">
              <Download className="w-4 h-4 text-gray-600 dark:text-gray-400" />
            </button>
          </div>
        );

      case 'audio':
        return (
          <div className="flex items-center space-x-3 p-3 bg-gray-100 dark:bg-gray-700 rounded-lg max-w-xs">
            <button
              onClick={() => setIsPlaying(!isPlaying)}
              className="p-2 bg-green-500 rounded-full hover:bg-green-600 transition-colors"
            >
              {isPlaying ? (
                <Pause className="w-5 h-5 text-white" />
              ) : (
                <Play className="w-5 h-5 text-white" />
              )}
            </button>
            <div className="flex-1">
              <div className="h-2 bg-gray-300 dark:bg-gray-600 rounded-full">
                <div className="h-2 bg-green-500 rounded-full w-1/3"></div>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                0:32 / 1:45
              </p>
            </div>
            <Volume2 className="w-4 h-4 text-gray-600 dark:text-gray-400" />
          </div>
        );

      default:
        return (
          <p className="text-gray-900 dark:text-white whitespace-pre-wrap break-words">
            {message.message}
          </p>
        );
    }
  };

  const renderMessageStatus = () => {
    if (!isOwn) return null;

    return (
      <div className="flex items-center space-x-1 text-gray-500 dark:text-gray-400">
        {message.status === 'sent' && <Check className="w-3 h-3" />}
        {message.status === 'delivered' && <CheckCheck className="w-3 h-3" />}
        {message.status === 'read' && <CheckCheck className="w-3 h-3 text-blue-500" />}
      </div>
    );
  };

  return (
    <div className={`flex ${isOwn ? 'justify-end' : 'justify-start'} group`}>
      <div className="relative max-w-[70%]">
        {/* Message Bubble */}
        <div
          className={`relative px-3 py-2 rounded-lg ${
            isOwn
              ? 'bg-green-500 text-white ml-auto'
              : 'bg-white dark:bg-gray-800 text-gray-900 dark:text-white border border-gray-200 dark:border-gray-700'
          }`}
        >
          {/* Sender Name for Group Chats */}
          {showSender && !isOwn && (
            <p className="text-xs font-semibold text-green-600 dark:text-green-400 mb-1">
              {message.sender}
            </p>
          )}

          {/* Message Content */}
          {renderMessageContent()}

          {/* Time and Status */}
          <div className={`flex items-center justify-end space-x-1 mt-1 ${
            isOwn ? 'text-white text-opacity-70' : 'text-gray-500 dark:text-gray-400'
          }`}>
            <span className="text-xs">
              {formatTime(message.timestamp)}
            </span>
            {renderMessageStatus()}
          </div>

          {/* Message Tail */}
          <div
            className={`absolute bottom-0 ${
              isOwn ? 'right-0 translate-x-1' : 'left-0 -translate-x-1'
            }`}
          >
            <div
              className={`w-3 h-3 transform rotate-45 ${
                isOwn 
                  ? 'bg-green-500' 
                  : 'bg-white dark:bg-gray-800 border-r border-b border-gray-200 dark:border-gray-700'
              }`}
            />
          </div>
        </div>

        {/* Message Menu */}
        <div className={`absolute top-0 ${isOwn ? 'left-0 -translate-x-8' : 'right-0 translate-x-8'} opacity-0 group-hover:opacity-100 transition-opacity`}>
          <div className="relative">
            <button
              onClick={() => setShowMenu(!showMenu)}
              className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-full transition-colors"
            >
              <MoreVertical className="w-4 h-4 text-gray-500 dark:text-gray-400" />
            </button>

            {showMenu && (
              <div className={`absolute top-full mt-1 w-32 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 z-10 ${
                isOwn ? 'right-0' : 'left-0'
              }`}>
                <button
                  onClick={() => setShowMenu(false)}
                  className="w-full px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 flex items-center space-x-2 text-sm"
                >
                  <Reply className="w-3 h-3" />
                  <span>Reply</span>
                </button>
                <button
                  onClick={handleCopyMessage}
                  className="w-full px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 flex items-center space-x-2 text-sm"
                >
                  <Copy className="w-3 h-3" />
                  <span>Copy</span>
                </button>
                {isOwn && (
                  <button
                    onClick={() => setShowMenu(false)}
                    className="w-full px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700 text-red-600 dark:text-red-400 flex items-center space-x-2 text-sm"
                  >
                    <Trash className="w-3 h-3" />
                    <span>Delete</span>
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default MessageBubble;