import { motion } from "motion/react";
import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import Button from "./Button";
import ServerCountdownTimer from "./ServerCountdownTimer";
import IconRenderer from "../common/IconRenderer";
import { useSocket } from "../socketHandler/socketProvider";
import { useAuth } from "../../contexts/AuthContext";
import styles from "../../styles/UI/RoomCard.module.css";

const RoomCard = ({ 
  room, 
  onJoinRoom, 
  isJoining = false,
  isJoined = false,
  index = 0 
}) => {
  const {
    id,
    roomId,
    playerCount,
    entryFee,
    prizePool,
    roomType,
    maxPlayers,
    nextGameStart,
    playersJoined,
    countdown
  } = room;
  
     const navigate = useNavigate();
  const { joinRoom: joinSocketRoom, roomInfo, socket } = useSocket();
  const { currentUser, userData } = useAuth();
  const [isSocketJoining, setIsSocketJoining] = useState(false);
  const [countdownExpired, setCountdownExpired] = useState(false);
  const [pendingReadyData, setPendingReadyData] = useState(null);

  // Handle combined API join and socket join
  const handleJoinRoom = async () => {
    if (isJoining || isSocketJoining || !currentUser || !userData) return;
    
    try {
      // First, call the API join (handled by parent Lobby component)
      const apiJoinResult = await onJoinRoom(room);
      console.log('RoomCard: API join result:', apiJoinResult);
      
      // Only proceed with socket join if API join was explicitly successful
      if (!apiJoinResult || apiJoinResult.success !== true) {
        console.warn('RoomCard: API join failed or not successful, skipping socket join', apiJoinResult);
        return;
      }
      
      // Then immediately join socket room
      setIsSocketJoining(true);
      
      const playerId = currentUser.uid;
      const name = userData.firstName || userData.displayName || 'Player';
      const avatar = userData.profile || userData.avatar || userData.photoURL || null;
      const mode = playerCount;
      const price = entryFee;
      const waitingRoomId = roomId;
      
      console.log('RoomCard: Joining socket room:', { playerId, name, mode, price, waitingRoomId });
      
      // Join socket room immediately
      joinSocketRoom(playerId, name, avatar, Number(mode), Number(price), waitingRoomId);
      
    } catch (error) {
      console.error('RoomCard: Join failed:', error);
      setIsSocketJoining(false);
    }
  };

  // Listen for socket room join success and redirect ONLY when room is full AND countdown expired
  useEffect(() => {
    if (!roomInfo) return;
    
    console.log('RoomCard: Received room info:', roomInfo);
    
    // Only redirect if room has reached maximum players AND countdown expired
    if (roomInfo.roomId && roomInfo.players && roomInfo.players.length >= maxPlayers) {
      if (countdownExpired) {
        console.log(`RoomCard: Room full and countdown expired, redirecting:`, roomInfo.roomId);
        navigate(`/game/${playerCount}/${roomInfo.roomId}`, {
          state: {
            room: {
              id: roomInfo.roomId,
              playerCount: playerCount,
            entryFee: entryFee,
            prizePool: prizePool,
              roomType: roomType,
            }
          }
        });
        // Reset socket joining state after successful redirect
        setIsSocketJoining(false);
      } else {
        console.log(`RoomCard: Room full but countdown not expired; waiting for countdown...`);
        setPendingReadyData({ roomId: roomInfo.roomId, players: roomInfo.players });
        // Keep isSocketJoining true to continue monitoring
      }
    } else {
      console.log(`RoomCard: Room not full yet (${roomInfo.players?.length || 0}/${maxPlayers}), waiting for more players...`);
      // Don't reset isSocketJoining here - keep monitoring for room changes
    }
  }, [roomInfo, navigate, playerCount, entryFee, prizePool, roomType, maxPlayers, countdownExpired]);

  // Listen for room events (ready and updates)
  useEffect(() => {
    if (!socket) return;

    const handleRoomReady = (data) => {
      console.log('RoomCard: Room ready received:', data);
      if (data.roomId && data.players && data.players.length >= maxPlayers) {
        if (countdownExpired) {
          console.log(`RoomCard: Room ready and countdown expired, redirecting:`, data.roomId);
          navigate(`/game/${playerCount}/${data.roomId}`, {
            state: {
              room: {
                id: data.roomId,
                playerCount: playerCount,
                entryFee: entryFee,
                prizePool: prizePool,
                roomType: roomType,
              }
            }
          });
        } else {
          console.log('RoomCard: Room ready but countdown not expired; storing and waiting...');
          setPendingReadyData({ roomId: data.roomId, players: data.players });
        }
      }
    };

    const handleRoomUpdate = (data) => {
      console.log('RoomCard: Room update received:', data);
      // This is just for debugging - roomReady should handle the redirect
    };

    socket.on('roomReady', handleRoomReady);
    socket.on('roomUpdate', handleRoomUpdate);

    return () => {
      socket.off('roomReady', handleRoomReady);
      socket.off('roomUpdate', handleRoomUpdate);
    };
  }, [socket, maxPlayers, navigate, playerCount, entryFee, prizePool, roomType, countdownExpired]);

  // When countdown expires, if we already have a full room pending, navigate now
  useEffect(() => {
    if (!countdownExpired || !pendingReadyData) return;
    if (pendingReadyData.players && pendingReadyData.players.length >= maxPlayers) {
      console.log('RoomCard: Countdown expired; redirecting to pending ready room:', pendingReadyData.roomId);
      navigate(`/game/${playerCount}/${pendingReadyData.roomId}`, {
        state: {
          room: {
            id: pendingReadyData.roomId,
            playerCount: playerCount,
          entryFee: entryFee,
          prizePool: prizePool,
            roomType: roomType,
          }
        }
      });
    }
  }, [countdownExpired, pendingReadyData, navigate, maxPlayers, playerCount, entryFee, prizePool, roomType]);

  const getPlayerCountIcon = (count) => {
    switch(count) {
      case 2: return 'users';
      case 4: return 'users';
      default: return 'users';
    }
  };




  return (
    <motion.div
      className={styles.card}
      initial={{ opacity: 0, y: 30 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ 
        duration: 0.6, 
        delay: index * 0.1,
        ease: "easeOut"
      }}
      whileHover={{ 
        y: -5,
        transition: { duration: 0.2 }
      }}
    >
      {/* Card Header - Now contains both player info and countdown */}
      <div className={styles.header}>
        <div className={styles.playerInfo}>
          <div className={styles.playerIcon}>
            <IconRenderer 
              name={getPlayerCountIcon(maxPlayers)} 
              size={18} 
              color="#FCD34D" 
            />
          </div>
          <span className={styles.playerText}>
            {maxPlayers} Players
          </span>
        </div>
        
        {/* Game Info - Moved to top right */}
        <div className={styles.gameInfo}>
          <ServerCountdownTimer 
            initialCountdown={countdown}
            nextGameStart={nextGameStart}
            onExpired={() => {
              console.log(`Room ${id} countdown expired`);
              setCountdownExpired(true);
            }}
            className={styles.countdown}
          />
        </div>
      </div>

      {/* Room Content */}
      <div className={styles.content}>
        {/* Entry Fee & Prize */}
        <div className={styles.moneyInfo}>        
          <div className={styles.prizePool}>
            <span className={styles.label}>Prize</span>
            <span className={styles.amount}>
              ₦{room.prizePool.toLocaleString()}
            </span>
          </div>
           <div className={styles.entryFee}>
            <span className={styles.label}>Entry</span>
            <span className={styles.amount}>
              ₦{room.entryFee.toLocaleString()}
            </span>
          </div>
        </div>

        {/* Players Waiting */}
        <div className={styles.playersWaiting}>
          <div className={styles.waitingInfo}>
            <IconRenderer name="users" size={16} color="#FCD34D" />
            <span className={styles.waitingText}>
              {playersJoined} player{playersJoined !== 1 ? 's' : ''} waiting
            </span>
          </div>
          <div className={styles.waitingIndicator}>
            <motion.div 
              className={styles.pulseIndicator}
              animate={{ 
                scale: [1, 1.2, 1],
                opacity: [0.5, 1, 0.5]
              }}
              transition={{ 
                duration: 2,
                repeat: Infinity,
                ease: "easeInOut"
              }}
            />
          </div>
        </div>
              
        {/* Join Button */}
        <div className={styles.joinSection}>
          <Button
            variant={isJoined ? "secondary" : "primary"}
            size="md"
            fullWidth
            loading={isJoining || isSocketJoining}
            disabled={isJoined || isJoining || isSocketJoining}
            onClick={handleJoinRoom}
          >
            {isJoining ? 'Joining...' : isSocketJoining ? 'Waiting for Players...' : isJoined ? 'Waiting for Game' : 'Join Game'}
          </Button>
        </div>
      </div>
    </motion.div>
  );
};

export default RoomCard;
