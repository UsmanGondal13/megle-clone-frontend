import { useState, useEffect, useRef } from 'react'

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ]
}

function App() {
  const [messages, setMessages] = useState([])
  const [inputValue, setInputValue] = useState('')
  const [status, setStatus] = useState('Allow camera access to connect...')
  const [cameraReady, setCameraReady] = useState(false) 
  const [debugLogs, setDebugLogs] = useState([]) // NEW: On-screen logger
  
  const ws = useRef(null)
  const localVideoRef = useRef(null)
  const remoteVideoRef = useRef(null)
  const peerConnectionRef = useRef(null)
  const localStreamRef = useRef(null)
  const iceCandidateQueue = useRef([])

  const logDebug = (msg) => {
    console.log(msg)
    setDebugLogs(prev => [...prev, `${new Date().toLocaleTimeString()} - ${msg}`])
  }

  const processCandidateQueue = async () => {
    logDebug(`Processing queue. Items: ${iceCandidateQueue.current.length}`)
    while (iceCandidateQueue.current.length > 0) {
      const candidate = iceCandidateQueue.current.shift()
      try {
        if (peerConnectionRef.current && peerConnectionRef.current.remoteDescription) {
          await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate))
          logDebug("Successfully added queued ICE candidate")
        }
      } catch (err) {
        logDebug(`Error adding queued candidate: ${err.message}`)
      }
    }
  }

  useEffect(() => {
    const startCamera = async () => {
      try {
        logDebug("Requesting camera permissions...")
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
        localStreamRef.current = stream
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream
        }
        logDebug("Camera active. Unlocking server connection.")
        setCameraReady(true) 
      } catch (error) {
        logDebug(`Camera Error: ${error.message}`)
        setStatus("Camera permission denied. Cannot connect to server.")
      }
    }
    startCamera()
  }, [])

  const createPeerConnection = () => {
    logDebug("Creating new RTCPeerConnection...")
    const pc = new RTCPeerConnection(ICE_SERVERS)
    
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        pc.addTrack(track, localStreamRef.current)
      })
      logDebug("Added local tracks to connection.")
    }

    pc.ontrack = (event) => {
      logDebug(`Received remote track! Kind: ${event.track.kind}`)
      if (remoteVideoRef.current && event.streams[0]) {
        remoteVideoRef.current.srcObject = event.streams[0]
        remoteVideoRef.current.play().then(() => {
          logDebug("Remote video playing successfully!")
        }).catch(error => {
          logDebug(`Autoplay blocked by browser: ${error.message}`)
        })
      }
    }

    pc.onicecandidate = (event) => {
      if (event.candidate && ws.current && ws.current.readyState === WebSocket.OPEN) {
        ws.current.send(JSON.stringify({
          type: 'webrtc_ice_candidate',
          candidate: event.candidate
        }))
      }
    }

    pc.oniceconnectionstatechange = () => {
      logDebug(`ICE State Changed: ${pc.iceConnectionState}`)
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        setStatus("Connected to stranger (Video Live)!")
      } else if (pc.iceConnectionState === 'failed') {
        setStatus("Video connection failed. Retrying...")
      }
    }

    return pc
  }

  const closeVideoCall = (clearQueue = true) => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close()
      peerConnectionRef.current = null
      logDebug("Closed old peer connection.")
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null
    }
    if (clearQueue) {
      iceCandidateQueue.current = []
    }
  }

  useEffect(() => {
    if (!cameraReady) return; 

    logDebug("Connecting to matching server...")
    ws.current = new WebSocket('wss://omegle-clone-backend-u5bk.onrender.com/ws')

    ws.current.onopen = () => {
      logDebug("Server connected.")
      setStatus("Connected! Waiting for backend to assign stranger...")
    }

    ws.current.onmessage = async (event) => {
      const data = JSON.parse(event.data)
      
      if (data.type === 'system') {
        setStatus(data.content)
        
        if (data.content === "Stranger has disconnected.") {
          logDebug("Stranger disconnected.")
          closeVideoCall(true) 
        }

        if (data.role === 'caller') {
          logDebug("Role assigned: CALLER. Generating offer...")
          closeVideoCall(false) 
          peerConnectionRef.current = createPeerConnection()
          const offer = await peerConnectionRef.current.createOffer()
          await peerConnectionRef.current.setLocalDescription(offer)
          
          ws.current.send(JSON.stringify({
            type: 'webrtc_offer',
            offer: offer
          }))
          logDebug("Offer sent to stranger.")
        }
      } 
      else if (data.type === 'chat_message') {
        setMessages((prev) => [...prev, `${data.sender}: ${data.content}`])
      }
      else if (data.type === 'webrtc_offer') {
        logDebug("Received offer from stranger. Generating answer...")
        closeVideoCall(false) 
        peerConnectionRef.current = createPeerConnection()
        await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(data.offer))
        
        await processCandidateQueue()

        const answer = await peerConnectionRef.current.createAnswer()
        await peerConnectionRef.current.setLocalDescription(answer)
        
        ws.current.send(JSON.stringify({
          type: 'webrtc_answer',
          answer: answer
        }))
        logDebug("Answer sent back.")
      }
      else if (data.type === 'webrtc_answer') {
        logDebug("Received answer back from stranger.")
        if (peerConnectionRef.current) {
          await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(data.answer))
          await processCandidateQueue()
        }
      }
      else if (data.type === 'webrtc_ice_candidate') {
        if (data.candidate) {
          if (peerConnectionRef.current && peerConnectionRef.current.remoteDescription) {
            try {
              await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(data.candidate))
            } catch (err) {
              logDebug(`Error adding direct candidate: ${err.message}`)
            }
          } else {
            iceCandidateQueue.current.push(data.candidate)
          }
        }
      }
    }

    ws.current.onclose = () => {
      logDebug("Server disconnected.")
      setStatus("Disconnected from server.")
      closeVideoCall(true)
    }

    return () => {
      if (ws.current) ws.current.close()
    }
  }, [cameraReady]) 

  const sendMessage = () => {
    if (ws.current && inputValue !== '') {
      ws.current.send(JSON.stringify({ type: 'chat_message', content: inputValue }))
      setMessages((prev) => [...prev, `You: ${inputValue}`])
      setInputValue('') 
    }
  }

  const handleSkip = () => {
    if (ws.current) {
      ws.current.send(JSON.stringify({ type: 'skip' }))
      setMessages([]) 
      setStatus("Skipping... looking for someone new.")
      closeVideoCall(true) 
    }
  }

  return (
    <div style={{ padding: '1rem', fontFamily: 'sans-serif', maxWidth: '800px', margin: '0 auto' }}>
      <h1 style={{ textAlign: 'center' }}>Omegle Clone Matchmaker</h1>
      <h3 style={{ color: 'blue', textAlign: 'center' }}>Status: {status}</h3>
      
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '20px', marginBottom: '20px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%', maxWidth: '300px' }}>
          <h4 style={{ margin: '0 0 10px 0' }}>You</h4>
          <video ref={localVideoRef} autoPlay playsInline muted style={{ width: '100%', aspectRatio: '4/3', objectFit: 'cover', backgroundColor: '#222', borderRadius: '8px' }} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%', maxWidth: '300px' }}>
          <h4 style={{ margin: '0 0 10px 0' }}>Stranger</h4>
          <video ref={remoteVideoRef} autoPlay playsInline controls style={{ width: '100%', aspectRatio: '4/3', objectFit: 'cover', backgroundColor: '#222', borderRadius: '8px' }} />
        </div>
      </div>

      <div style={{ maxWidth: '620px', margin: '0 auto' }}>
        <div style={{ border: '1px solid #ccc', padding: '10px', height: '180px', overflowY: 'scroll', marginBottom: '10px' }}>
          {messages.map((msg, index) => (
            <p key={index} style={{ margin: '5px 0' }}>{msg}</p>
          ))}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '20px' }}>
          <input type="text" value={inputValue} onChange={(e) => setInputValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && sendMessage()} placeholder="Type a message..." style={{ padding: '8px', flex: '1', minWidth: '150px' }} />
          <button onClick={sendMessage} style={{ padding: '8px 20px' }}>Send</button>
          <button onClick={handleSkip} style={{ padding: '8px 20px', backgroundColor: '#ff4444', color: 'white', border: 'none', cursor: 'pointer' }}>Next / Skip</button>
        </div>

        {/* SYSTEM DIAGNOSTICS LOGGER */}
        <div style={{ backgroundColor: '#111', color: '#0f0', padding: '10px', fontFamily: 'monospace', fontSize: '12px', height: '200px', overflowY: 'scroll', borderRadius: '4px' }}>
          <p style={{ margin: 0, fontWeight: 'bold', color: '#fff' }}>--- SYSTEM LOGS ---</p>
          {debugLogs.map((log, i) => <div key={i}>{log}</div>)}
        </div>
      </div>
    </div>
  )
}

export default App