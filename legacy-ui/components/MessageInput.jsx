import React, { useState, useRef, useEffect } from 'react';
import { useSocket } from '../context/SocketContext';
import {
  Send,
  Paperclip,
  Mic,
  MicOff,
  Smile,
  Image as ImageIcon,
  File,
  Camera,
  X,
  Play,
  Pause,
  Square,
  Volume2
} from 'lucide-react';

const EMOJI_LIST = [
  '😀', '😂', '😍', '🤔', '😭', '😡', '👍', '👎', '❤️', '🔥', 
  '💯', '🎉', '🙈', '🙉', '🙊', '💪', '👌', '✌️', '🤞', '🤟',
  '👋', '🤚', '✋', '👊', '✊', '🤝', '🙏', '💅', '🤳', '💃',
  '🕺', '👯', '🧘', '🏃', '🚶', '🧍', '🧎', '🏋️', '🤸', '🤾',
  '🏌️', '🏄', '🚣', '🏊', '⛹️', '🚴', '🚵', '🤺', '🏇', '⛷️',
  '🏂', '🪂', '🏆', '🥇', '🥈', '🥉', '🏅', '🎖️', '🏵️', '🎗️'
];

const MessageInput = ({ chat, onSendMessage, disabled }) => {
  const [message, setMessage] = useState('');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [selectedFile, setSelectedFile] = useState(null);
  const [isTyping, setIsTyping] = useState(false);
  const [voicePreview, setVoicePreview] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [recordingPermission, setRecordingPermission] = useState(null);
  
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const imageInputRef = useRef(null);
  const recordingIntervalRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const typingTimeoutRef = useRef(null);
  const audioRef = useRef(null);
  const streamRef = useRef(null);

  const { sendTyping } = useSocket();

  // Check microphone permission on mount
  useEffect(() => {
    checkMicrophonePermission();
    return () => {
      cleanup();
    };
  }, []);

  const checkMicrophonePermission = async () => {
    try {
      const permission = await navigator.permissions.query({ name: 'microphone' });
      setRecordingPermission(permission.state);
      
      permission.onchange = () => {
        setRecordingPermission(permission.state);
      };
    } catch (error) {
      console.log('Permission API not supported');
    }
  };

  const cleanup = () => {
    if (recordingIntervalRef.current) {
      clearInterval(recordingIntervalRef.current);
    }
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
  };

  useEffect(() => {
    if (isRecording) {
      recordingIntervalRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
    } else {
      clearInterval(recordingIntervalRef.current);
    }

    return () => clearInterval(recordingIntervalRef.current);
  }, [isRecording]);

  const handleSend = () => {
    if (selectedFile) {
      handleFileSend();
    } else if (voicePreview) {
      handleVoiceSend();
    } else if (message.trim()) {
      onSendMessage(message.trim(), 'text');
      setMessage('');
      stopTyping();
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleTextareaChange = (e) => {
    setMessage(e.target.value);
    
    // Auto-resize textarea
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px';
    }

    // Handle typing indicators
    if (e.target.value.trim() && !isTyping) {
      setIsTyping(true);
      sendTyping(chat.id, true);
    }

    // Clear existing timeout
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    // Set new timeout to stop typing
    typingTimeoutRef.current = setTimeout(() => {
      stopTyping();
    }, 2000);
  };

  const stopTyping = () => {
    if (isTyping) {
      setIsTyping(false);
      sendTyping(chat.id, false);
    }
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }
  };

  const handleEmojiSelect = (emoji) => {
    const cursorPosition = textareaRef.current?.selectionStart || message.length;
    const newMessage = message.slice(0, cursorPosition) + emoji + message.slice(cursorPosition);
    setMessage(newMessage);
    setShowEmojiPicker(false);
    
    // Focus back to textarea and set cursor position
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(cursorPosition + emoji.length, cursorPosition + emoji.length);
      }
    }, 0);
  };

  const handleFileSelect = (e) => {
    const file = e.target.files[0];
    if (file) {
      // Check file size (10MB limit)
      if (file.size > 10 * 1024 * 1024) {
        alert('File size must be less than 10MB');
        return;
      }
      
      setSelectedFile(file);
      setShowAttachMenu(false);
    }
  };

  const handleFileSend = async () => {
    if (!selectedFile) return;

    const formData = new FormData();
    formData.append('file', selectedFile);
    formData.append('chatId', chat.id);

    try {
      const response = await fetch('http://localhost:5000/api/upload', {
        method: 'POST',
        body: formData,
        credentials: 'include'
      });
      
      const data = await response.json();
      
      if (response.ok) {
        const messageType = selectedFile.type.startsWith('image/') ? 'image' : 'file';
        onSendMessage(data.filePath, messageType, {
          fileName: selectedFile.name,
          fileSize: (selectedFile.size / 1024 / 1024).toFixed(2) + ' MB',
          fileType: selectedFile.type
        });
        setSelectedFile(null);
      } else {
        console.error('File upload failed:', data.error);
        alert('Failed to upload file: ' + (data.error || 'Unknown error'));
      }
    } catch (error) {
      console.error('File upload error:', error);
      alert('Failed to upload file: Network error');
    }
  };

  const requestMicrophonePermission = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(track => track.stop()); // Stop immediately after getting permission
      setRecordingPermission('granted');
      return true;
    } catch (error) {
      console.error('Microphone permission denied:', error);
      setRecordingPermission('denied');
      alert('Microphone permission is required for voice messages');
      return false;
    }
  };

  const startRecording = async () => {
    try {
      // Check permission first
      if (recordingPermission === 'denied') {
        alert('Microphone permission is required for voice messages');
        return;
      }

      if (recordingPermission !== 'granted') {
        const permitted = await requestMicrophonePermission();
        if (!permitted) return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 44100
        }
      });
      
      streamRef.current = stream;
      mediaRecorderRef.current = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4'
      });
      
      audioChunksRef.current = [];

      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorderRef.current.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { 
          type: mediaRecorderRef.current.mimeType 
        });
        setVoicePreview(audioBlob);
        
        // Clean up stream
        if (streamRef.current) {
          streamRef.current.getTracks().forEach(track => track.stop());
          streamRef.current = null;
        }
      };

      mediaRecorderRef.current.start(100); // Collect data every 100ms
      setIsRecording(true);
      setRecordingTime(0);
      
    } catch (error) {
      console.error('Failed to start recording:', error);
      alert('Failed to access microphone. Please check your permissions.');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      setRecordingTime(0);
    }
  };

  const cancelRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      setRecordingTime(0);
      setVoicePreview(null);
    }
  };

  const handleVoiceSend = async () => {
    if (!voicePreview) return;

    const formData = new FormData();
    formData.append('file', voicePreview, `voice-${Date.now()}.webm`);
    formData.append('type', 'audio');
    formData.append('chatId', chat.id);

    try {
      const response = await fetch('http://localhost:5000/api/upload', {
        method: 'POST',
        body: formData,
        credentials: 'include'
      });
      
      if (response.ok) {
        const data = await response.json();
        onSendMessage(data.filePath, 'audio', {
          duration: recordingTime,
          fileName: 'Voice Message'
        });
        setVoicePreview(null);
      } else {
        console.error('Voice message upload failed');
        alert('Failed to send voice message');
      }
    } catch (error) {
      console.error('Voice message error:', error);
      alert('Failed to send voice message');
    }
  };

  const playVoicePreview = () => {
    if (voicePreview && !isPlaying) {
      const url = URL.createObjectURL(voicePreview);
      audioRef.current = new Audio(url);
      
      audioRef.current.onended = () => {
        setIsPlaying(false);
        URL.revokeObjectURL(url);
        audioRef.current = null;
      };
      
      audioRef.current.onerror = () => {
        setIsPlaying(false);
        URL.revokeObjectURL(url);
        audioRef.current = null;
        alert('Failed to play voice message');
      };
      
      audioRef.current.play();
      setIsPlaying(true);
    } else if (audioRef.current && isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    }
  };

  const formatRecordingTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Close menus when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (!event.target.closest('.emoji-picker') && !event.target.closest('.emoji-button')) {
        setShowEmojiPicker(false);
      }
      if (!event.target.closest('.attach-menu') && !event.target.closest('.attach-button')) {
        setShowAttachMenu(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  if (disabled) {
    return (
      <div className="px-4 py-3 bg-gray-100 dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-center text-gray-500 dark:text-gray-400">
          Select a chat to start messaging
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 py-3 bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700">
      {/* File Preview */}
      {selectedFile && (
        <div className="mb-3 p-3 bg-gray-50 dark:bg-gray-700 rounded-lg animate-slideUp">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-blue-500 rounded-full">
                {selectedFile.type.startsWith('image/') ? (
                  <ImageIcon className="w-4 h-4 text-white" />
                ) : (
                  <File className="w-4 h-4 text-white" />
                )}
              </div>
              <div>
                <p className="font-medium text-gray-900 dark:text-white text-sm">
                  {selectedFile.name}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
                </p>
              </div>
            </div>
            <button
              onClick={() => setSelectedFile(null)}
              className="p-1 hover:bg-gray-200 dark:hover:bg-gray-600 rounded transition-colors"
            >
              <X className="w-4 h-4 text-gray-500 dark:text-gray-400" />
            </button>
          </div>
          {selectedFile.type.startsWith('image/') && (
            <div className="mt-3">
              <img
                src={URL.createObjectURL(selectedFile)}
                alt="Preview"
                className="max-w-full h-32 object-cover rounded"
                onLoad={(e) => URL.revokeObjectURL(e.target.src)}
              />
            </div>
          )}
        </div>
      )}

      {/* Voice Preview */}
      {voicePreview && (
        <div className="mb-3 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg animate-slideUp">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <button
                onClick={playVoicePreview}
                className="p-2 bg-green-500 rounded-full hover:bg-green-600 transition-colors focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2"
              >
                {isPlaying ? (
                  <Pause className="w-4 h-4 text-white" />
                ) : (
                  <Play className="w-4 h-4 text-white" />
                )}
              </button>
              <div>
                <p className="font-medium text-green-700 dark:text-green-300 text-sm">
                  Voice Message
                </p>
                <p className="text-xs text-green-600 dark:text-green-400">
                  {formatRecordingTime(recordingTime)} • Tap to preview
                </p>
              </div>
            </div>
            <div className="flex items-center space-x-2">
              <button
                onClick={handleVoiceSend}
                className="px-3 py-1 bg-green-500 text-white rounded text-sm hover:bg-green-600 transition-colors focus:outline-none focus:ring-2 focus:ring-green-500"
              >
                Send
              </button>
              <button
                onClick={() => setVoicePreview(null)}
                className="p-1 hover:bg-green-200 dark:hover:bg-green-800 rounded transition-colors"
              >
                <X className="w-4 h-4 text-green-600 dark:text-green-400" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Recording UI */}
      {isRecording && (
        <div className="mb-3 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg animate-slideUp">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="flex items-center space-x-2">
                <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse"></div>
                <span className="text-red-600 dark:text-red-400 font-medium">
                  Recording... {formatRecordingTime(recordingTime)}
                </span>
              </div>
            </div>
            <div className="flex items-center space-x-2">
              <button
                onClick={stopRecording}
                className="px-3 py-1 bg-red-500 text-white rounded text-sm hover:bg-red-600 transition-colors focus:outline-none focus:ring-2 focus:ring-red-500"
              >
                <Square className="w-3 h-3 inline mr-1" />
                Stop
              </button>
              <button
                onClick={cancelRecording}
                className="p-1 hover:bg-red-200 dark:hover:bg-red-800 rounded transition-colors"
              >
                <X className="w-4 h-4 text-red-600 dark:text-red-400" />
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-end space-x-2">
        {/* Attachment Menu */}
        <div className="relative attach-menu">
          <button
            onClick={() => setShowAttachMenu(!showAttachMenu)}
            className="attach-button p-2 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-gray-500"
          >
            <Paperclip className="w-5 h-5" />
          </button>

          {showAttachMenu && (
            <div className="absolute bottom-full mb-2 left-0 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 p-2 space-y-1 min-w-48 z-10 animate-slideUp">
              <button
                onClick={() => {
                  imageInputRef.current?.click();
                  setShowAttachMenu(false);
                }}
                className="w-full flex items-center space-x-3 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 rounded text-gray-700 dark:text-gray-300 transition-colors"
              >
                <div className="w-8 h-8 bg-purple-500 rounded-full flex items-center justify-center">
                  <ImageIcon className="w-4 h-4 text-white" />
                </div>
                <div className="text-left">
                  <p className="text-sm font-medium">Photos & Videos</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">Share images and videos</p>
                </div>
              </button>
              
              <button
                onClick={() => {
                  fileInputRef.current?.click();
                  setShowAttachMenu(false);
                }}
                className="w-full flex items-center space-x-3 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 rounded text-gray-700 dark:text-gray-300 transition-colors"
              >
                <div className="w-8 h-8 bg-blue-500 rounded-full flex items-center justify-center">
                  <File className="w-4 h-4 text-white" />
                </div>
                <div className="text-left">
                  <p className="text-sm font-medium">Documents</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">Share files and documents</p>
                </div>
              </button>
              
              <button
                onClick={() => {
                  setShowAttachMenu(false);
                  // TODO: Implement camera functionality
                  alert('Camera feature coming soon!');
                }}
                className="w-full flex items-center space-x-3 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 rounded text-gray-700 dark:text-gray-300 transition-colors"
              >
                <div className="w-8 h-8 bg-green-500 rounded-full flex items-center justify-center">
                  <Camera className="w-4 h-4 text-white" />
                </div>
                <div className="text-left">
                  <p className="text-sm font-medium">Camera</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">Take a photo or video</p>
                </div>
              </button>
            </div>
          )}
        </div>

        {/* Message Input */}
        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            value={message}
            onChange={handleTextareaChange}
            onKeyPress={handleKeyPress}
            placeholder="Type a message"
            className="w-full px-4 py-2 pr-10 bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white rounded-full resize-none focus:outline-none focus:ring-2 focus:ring-green-500 transition-all"
            rows={1}
            style={{ minHeight: '40px', maxHeight: '120px' }}
            disabled={isRecording || voicePreview}
          />
          
          {/* Emoji Button */}
          <div className="absolute right-2 top-1/2 transform -translate-y-1/2 emoji-picker">
            <button
              onClick={() => setShowEmojiPicker(!showEmojiPicker)}
              className="emoji-button p-1 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors focus:outline-none focus:ring-2 focus:ring-gray-500 rounded"
            >
              <Smile className="w-5 h-5" />
            </button>

            {/* Emoji Picker */}
            {showEmojiPicker && (
              <div className="absolute bottom-full right-0 mb-2 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 p-3 max-w-xs z-20 animate-slideUp">
                <div className="flex justify-between items-center mb-2">
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Emojis</h3>
                  <button
                    onClick={() => setShowEmojiPicker(false)}
                    className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
                  >
                    <X className="w-3 h-3 text-gray-500 dark:text-gray-400" />
                  </button>
                </div>
                <div className="grid grid-cols-8 gap-1 max-h-48 overflow-y-auto">
                  {EMOJI_LIST.map((emoji, index) => (
                    <button
                      key={index}
                      onClick={() => handleEmojiSelect(emoji)}
                      className="w-8 h-8 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-lg flex items-center justify-center transition-colors focus:outline-none focus:ring-2 focus:ring-green-500"
                      title={emoji}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Send/Voice Button */}
        {message.trim() || selectedFile || voicePreview ? (
          <button
            onClick={handleSend}
            className="p-2 bg-green-500 text-white rounded-full hover:bg-green-600 transition-colors focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2"
            title="Send message"
          >
            <Send className="w-5 h-5" />
          </button>
        ) : (
          <button
            onMouseDown={startRecording}
            onMouseUp={stopRecording}
            onMouseLeave={stopRecording}
            onTouchStart={startRecording}
            onTouchEnd={stopRecording}
            className={`p-2 rounded-full transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 ${
              isRecording 
                ? 'bg-red-500 text-white scale-110 focus:ring-red-500' 
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 focus:ring-gray-500'
            }`}
            title={isRecording ? 'Recording... Release to stop' : 'Hold to record voice message'}
          >
            {isRecording ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
          </button>
        )}
      </div>

      {/* Hidden File Inputs */}
      <input
        ref={fileInputRef}
        type="file"
        onChange={handleFileSelect}
        className="hidden"
        accept=".pdf,.doc,.docx,.txt,.xlsx,.xls,.ppt,.pptx,.zip,.rar"
      />
      <input
        ref={imageInputRef}
        type="file"
        onChange={handleFileSelect}
        className="hidden"
        accept="image/*,video/*"
      />
    </div>
  );
};

export default MessageInput;