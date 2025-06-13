import React, { useEffect, useState } from 'react';
import './App.css';

// Types for Canvas Kit and Freshdesk integration
type CanvasComponent = {
  type: string;
  id: string;
  text?: string;
  align?: string;
  style?: string;
  label?: string;
  options?: Array<{
    type: string;
    id: string;
    text: string;
    value?: any;
  }>;
  action?: {
    type: string;
  };
  placeholder?: string;
  value?: string;
  required?: boolean;
};

// Types for Freshdesk entities
type FreshdeskMailbox = {
  id: number;
  name: string;
  support_email: string;
  product_id: number;
};

type FreshdeskStatus = {
  id: number;
  label: string;
};

type FreshdeskPriority = {
  label: string;
  value: number;
};

type TicketResponse = {
  id: number;
  subject: string;
  created_at: string;
};

type IntercomContext = {
  customer?: {
    email?: string;
    name?: string;
  };
  email?: string;
  name?: string;
  conversation?: {
    id?: string;
    custom_attributes?: {
      default_title?: string;
      default_description?: string;
    }
  };
  custom_attributes?: {
    default_title?: string;
    default_description?: string;
  };
  default_title?: string;
  default_description?: string;
};

type CanvasContent = {
  components: CanvasComponent[];
};

type Canvas = {
  content: CanvasContent;
};

// Type for the response from canvas initialization
type InitializeResponse = {
  canvas: Canvas;
  intercomContext?: IntercomContext;
};

// Function to initialize the Intercom Canvas
const initializeCanvas = async (): Promise<InitializeResponse> => {
  try {
    console.log('Initializing canvas...');
    // Use relative URL to work with both local and ngrok environments
    const response = await fetch('/api/initialize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({})
    });

    console.log('Response status:', response.status);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Server error:', errorText);
      throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
    }

    const data = await response.json();
    console.log('Received canvas data:', data);
    return data;
  } catch (error) {
    console.error('Error initializing canvas:', error);
    // Return a default canvas in case of error
    return {
      canvas: {
        content: {
          components: [
            {
              type: "text",
              id: "error",
              text: "Failed to load the app. Please refresh the page or try again later.",
              align: "center",
              style: "header",
            }
          ]
        }
      }
    };
  }
};

// Mock function to simulate form submission
const submitCanvas = async (componentId: string, inputValues: any): Promise<{ canvas: Canvas }> => {
  try {
    const response = await fetch('/api/submit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        component_id: componentId,
        input_values: inputValues,
      }),
    });
    return await response.json();
  } catch (error) {
    console.error('Error submitting form:', error);
    throw error;
  }
};

function App() {
  const [canvas, setCanvas] = useState<Canvas | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showTicketForm, setShowTicketForm] = useState(false);
  const [ticketCreated, setTicketCreated] = useState(false);
  const [ticketResponse, setTicketResponse] = useState<TicketResponse | null>(null);
  const [recentTickets, setRecentTickets] = useState<TicketResponse[]>([]);
  
  // Freshdesk data states
  const [mailboxes, setMailboxes] = useState<FreshdeskMailbox[]>([]);
  const [statuses, setStatuses] = useState<FreshdeskStatus[]>([]);
  const [priorities, setPriorities] = useState<FreshdeskPriority[]>([]);
  const [intercomContext, setIntercomContext] = useState<IntercomContext>({});
  const [isDataLoaded, setIsDataLoaded] = useState(false);
  
  // Form field states
  const [email, setEmail] = useState('');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [selectedMailbox, setSelectedMailbox] = useState<number | null>(null);
  const [selectedStatus, setSelectedStatus] = useState<number | null>(null);
  const [selectedPriority, setSelectedPriority] = useState<number | null>(null);

  // Initialize the canvas when the component mounts
  useEffect(() => {
    const init = async () => {
      try {
        // Get data from Intercom via initialization endpoint
        const data = await initializeCanvas();
        setCanvas(data.canvas);
        
        // Store Intercom context if available
        if (data.intercomContext) {
          setIntercomContext(data.intercomContext);
          
          // Auto-populate email if available
          if (data.intercomContext.customer?.email) {
            setEmail(data.intercomContext.customer.email);
          }
          
          // Auto-populate subject and description if available
          if (data.intercomContext.conversation?.custom_attributes) {
            const attrs = data.intercomContext.conversation.custom_attributes;
            if (attrs.default_title) {
              setSubject(attrs.default_title);
            }
            if (attrs.default_description) {
              setDescription(attrs.default_description);
            }
          }
        }
        
        // Fetch Freshdesk data (mailboxes, statuses, priorities)
        await fetchFreshdeskData();
        
        setIsLoading(false);
      } catch (err) {
        setError('Failed to load the app. Please try again later.');
        setIsLoading(false);
        console.error(err);
      }
    };

    init();
  }, []);
  
  // Use relative URLs to work with both local and ngrok environments
  const API_BASE_URL = '';

  // Fetch Freshdesk data for dropdowns
  const fetchFreshdeskData = async () => {
    try {
      // Reset data loaded state
      setIsDataLoaded(false);
      
      // Fetch mailboxes
      const mailboxesResponse = await fetch(`${API_BASE_URL}/api/freshdesk/mailboxes`);
      if (!mailboxesResponse.ok) throw new Error('Failed to fetch mailboxes');
      const mailboxesData = await mailboxesResponse.json();
      setMailboxes(mailboxesData);
      
      // Fetch statuses
      const statusesResponse = await fetch(`${API_BASE_URL}/api/freshdesk/statuses`);
      if (!statusesResponse.ok) throw new Error('Failed to fetch statuses');
      const statusesData = await statusesResponse.json();
      setStatuses(statusesData);
      
      // Fetch priorities
      const prioritiesResponse = await fetch(`${API_BASE_URL}/api/freshdesk/priorities`);
      if (!prioritiesResponse.ok) throw new Error('Failed to fetch priorities');
      const prioritiesData = await prioritiesResponse.json();
      setPriorities(prioritiesData);
      
      // All data loaded successfully
      setIsDataLoaded(true);
    } catch (error) {
      console.error('Error fetching Freshdesk data:', error);
      setError('Failed to load Freshdesk data. Please try again later.');
      setIsDataLoaded(false);
    }
  };

  // Handle form submission
  const handleSubmit = async () => {
    try {
      // Basic validation
      if (!email || !subject || !description || !selectedMailbox || !selectedStatus || !selectedPriority) {
        setError('Please fill in all required fields.');
        return;
      }
      
      // Find the selected mailbox to get its product_id
      const mailbox = mailboxes.find(m => m.id === selectedMailbox);
      if (!mailbox) {
        setError('Invalid mailbox selection.');
        return;
      }
      
      // Get the conversation ID from the Intercom context
      const conversationId = intercomContext?.conversation?.id;
      
      // Create the ticket payload
      const ticketData = {
        email,
        subject,
        description,
        status: selectedStatus,
        priority: selectedPriority,
        product_id: mailbox.product_id,
        // Add conversation ID if available
        ...(conversationId && { conversation_id: conversationId.toString() })
      };
      
      console.log('Creating ticket with data:', ticketData);
      
      // Submit the ticket creation request
      const response = await fetch(`${API_BASE_URL}/api/freshdesk/create-ticket`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(ticketData),
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to create ticket');
      }
      
      const data = await response.json();
      setTicketResponse(data);
      
      // Add the new ticket to the recent tickets list
      setRecentTickets(prevTickets => [data, ...prevTickets]);
      setTicketCreated(true);
    } catch (err: any) {
      setError(err.message || 'Failed to create the ticket. Please try again.');
      console.error(err);
    }
  };
  
  // Handle opening the ticket form
  const handleCreateTicket = () => {
    setShowTicketForm(true);
    setTicketCreated(false);
    setTicketResponse(null);
    setError(null);
  };
  
  // Handle canceling ticket creation
  const handleCancel = async () => {
    // Just hide the form without showing 'Ticket creation cancelled'
    setShowTicketForm(false);
    setError(null);
    
    // Fetch recent tickets from Freshdesk to refresh the list
    try {
      const response = await fetch(`${API_BASE_URL}/api/freshdesk/recent-tickets`);
      if (response.ok) {
        const tickets = await response.json();
        setRecentTickets(tickets);
      }
    } catch (error) {
      console.error('Error fetching recent tickets:', error);
    }
  };

  // Format date from UTC to readable format
  const formatDate = (utcDateString: string) => {
    const date = new Date(utcDateString);
    return date.toLocaleDateString();
  };

  // Render ticket creation button or ticket creation form
  const renderContent = () => {
    // If ticket has been created, show ticket information
    if (ticketCreated && ticketResponse) {
      return (
        <div className="ticket-created">
          <div className="ticket-header">Recent Tickets</div>
          <div className="ticket-item">
            <div className="ticket-subject">{ticketResponse.subject}</div>
            <div className="ticket-details">#{ticketResponse.id} {formatDate(ticketResponse.created_at)}</div>
          </div>
          <button
            className="canvas-button primary view-more-button"
            onClick={() => setTicketCreated(false)}
          >
            View More
          </button>
          <button
            className="canvas-button primary create-ticket-button"
            onClick={handleCreateTicket}
          >
            Create a Ticket
          </button>
        </div>
      );
    }
    
    // If ticket form is visible, show the form
    if (showTicketForm) {
      return (
        <div className="ticket-form">
          <div className="form-field">
            <label>Email*</label>
            <input 
              type="email" 
              value={email} 
              onChange={(e) => setEmail(e.target.value)} 
              placeholder="Enter email"
              required
            />
          </div>
          
          <div className="form-field">
            <label>Subject*</label>
            <input 
              type="text" 
              value={subject} 
              onChange={(e) => setSubject(e.target.value)} 
              placeholder="Enter subject"
              required
            />
          </div>
          
          <div className="form-field">
            <label>Description*</label>
            <textarea 
              value={description} 
              onChange={(e) => setDescription(e.target.value)} 
              placeholder="Enter description"
              required
            />
          </div>
          
          <div className="form-field">
            <label>Configure Email*</label>
            <select 
              value={selectedMailbox || ''} 
              onChange={(e) => setSelectedMailbox(Number(e.target.value))}
              required
            >
              <option value="">Choose one...</option>
              {mailboxes.map(mailbox => (
                <option key={mailbox.id} value={mailbox.id}>
                  {mailbox.name} ({mailbox.support_email})
                </option>
              ))}
            </select>
          </div>
          
          <div className="form-field">
            <label>Status*</label>
            <select 
              value={selectedStatus || ''} 
              onChange={(e) => setSelectedStatus(Number(e.target.value))}
              required
            >
              <option value="">Choose one...</option>
              {statuses.map(status => (
                <option key={status.id} value={status.id}>
                  {status.label}
                </option>
              ))}
            </select>
          </div>
          
          <div className="form-field">
            <label>Priority*</label>
            <select 
              value={selectedPriority || ''} 
              onChange={(e) => setSelectedPriority(Number(e.target.value))}
              required
            >
              <option value="">Choose one...</option>
              {priorities.map(priority => (
                <option key={priority.value} value={priority.value}>
                  {priority.label}
                </option>
              ))}
            </select>
          </div>
          
          <div className="form-actions">
            <button className="canvas-button primary" onClick={handleSubmit}>Create</button>
            <button className="canvas-button secondary" onClick={handleCancel}>Cancel</button>
          </div>
        </div>
      );
    }
    
    // By default, show the "Create a Ticket" button and recent tickets section
    return (
      <div className="create-ticket-container">
        <button 
          className={`canvas-button primary create-ticket-button ${!isDataLoaded ? 'disabled' : ''}`}
          onClick={isDataLoaded ? handleCreateTicket : undefined}
          disabled={!isDataLoaded}
        >
          {isDataLoaded ? 'Create a Ticket' : 'Loading...'}
        </button>
        {!isDataLoaded && (
          <div className="loading-text">Loading Freshdesk data...</div>
        )}
        
        <div className="recent-tickets-section">
          <div className="ticket-header">Recent Tickets</div>
          {recentTickets.length > 0 ? (
            recentTickets.map(ticket => (
              <div className="ticket-item" key={ticket.id}>
                <div className="ticket-subject">{ticket.subject}</div>
                <div className="ticket-details">#{ticket.id} {formatDate(ticket.created_at)}</div>
              </div>
            ))
          ) : (
            <div className="no-tickets">No recent tickets</div>
          )}
        </div>
      </div>
    );
  };

  if (isLoading) {
    return <div className="loading">Loading Intercom Canvas App...</div>;
  }

  return (
    <div className="intercom-canvas-app">
      <div className="canvas-container">
        {error && <div className="error">{error}</div>}
        {renderContent()}
      </div>
    </div>
  );
}

export default App;
