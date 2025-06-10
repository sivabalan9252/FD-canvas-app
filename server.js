require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const bodyParser = require('body-parser');
const { fetchIntercomConversation, formatConversationAsHtml, addConversationTranscriptToTicket, createFreshdeskTicket } = require('./conversation-helper');

const app = express();
const PORT = 3001;

// In-memory store for tracking in-progress tickets
// Key: email, Value: { inProgress: boolean, ticketId: number (if created) }
const ticketTracker = new Map();

// Freshdesk API configuration
const FRESHDESK_DOMAIN = process.env.FRESHDESK_DOMAIN;
const FRESHDESK_API_KEY = process.env.FRESHDESK_API_KEY;
const FRESHDESK_PASSWORD = process.env.FRESHDESK_PASSWORD;

// Base64 encode the API key and password for Basic Auth
// Base64 auth is handled within the createFreshdeskTicket function

// Increase request size limits
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(bodyParser.json());

// Enhanced CORS configuration to handle React development server requests and ngrok
app.use(cors({
  origin: '*', // Allow all origins for development
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With', 'Origin']
}));

// Add specific CORS headers for all responses
app.use((req, res, next) => {
  // Log the request origin for debugging
  console.log('Request origin:', req.headers.origin);
  
  // Set CORS headers
  res.header('Access-Control-Allow-Origin', '*'); // Allow all origins
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE, PATCH');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  // Handle preflight OPTIONS requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  next();
});

// Simple request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Simple test endpoint
app.get('/api/health', (req, res) => {
  console.log('Health check received');
  res.json({ status: 'ok', message: 'Server is running' });
});

// Process Intercom context and initialize canvas with direct rendering
app.post('/api/initialize', async (req, res) => {
  console.log('Initializing canvas...', new Date().toISOString());
  console.log('Request body keys:', Object.keys(req.body));
  
  try {
    // Extract useful information from Intercom's initialization request
    const conversation = req.body.conversation || {};
    const customer = req.body.customer || {};
    const contact = req.body.contact || {};
    
    // Try multiple possible locations for the email
    const customerEmail = customer.email || 
                         contact.email || 
                         (conversation.contact ? conversation.contact.email : '') || '';
                         
    // Always clear any in-progress tickets when Canvas is initialized
    if (customerEmail && ticketTracker.has(customerEmail)) {
      const ticketInfo = ticketTracker.get(customerEmail);
      // Only keep completed tickets in the tracker
      if (ticketInfo.inProgress) {
        console.log(`Clearing in-progress ticket state for ${customerEmail} during initialization`);
        ticketTracker.delete(customerEmail);
      }
    }
    
    // Get contact name from contact or customer object
    const contactName = contact.name || customer.name || '';
    
    // Always use 'Conversation from [Contact Name]' as the subject
    const defaultTitle = contactName ? `Conversation from ${contactName}` : 'New Conversation';
                         
    const defaultDescription = (conversation.custom_attributes ? conversation.custom_attributes.default_description : '') || 
                              (conversation.source ? conversation.source.body : '') || 
                              '';
    
    console.log('Customer email:', customerEmail);
    console.log('Default title:', defaultTitle);
    console.log('Default description:', defaultDescription);
    
    // Store context data in app.locals for later use in submit endpoint
    app.locals.intercomContext = {
      customerEmail,
      defaultTitle,
      defaultDescription
    };
    
    // Fetch recent tickets if we have a customer email
    let recentTickets = [];
    if (customerEmail) {
      try {
        // Fetch recent tickets from Freshdesk API
        const ticketsResponse = await axios.get(`${FRESHDESK_DOMAIN}/api/v2/tickets?email=${encodeURIComponent(customerEmail)}&order_by=created_at&order_type=desc&per_page=5`, {
          auth: {
            username: FRESHDESK_API_KEY,
            password: FRESHDESK_PASSWORD
          },
          headers: {
            'Content-Type': 'application/json'
          }
        });
        
        recentTickets = ticketsResponse.data.map(ticket => ({
          id: ticket.id,
          subject: ticket.subject,
          created_at: ticket.created_at
        }));
        
        console.log(`Found ${recentTickets.length} recent tickets for ${customerEmail}`);
      } catch (error) {
        console.error('Error fetching recent tickets during initialization:', error.response?.data || error.message);
        // Continue with initialization even if ticket fetching fails
      }
    }
    
    // Following the Intercom Inbox App documentation format exactly
    // Create a simplified Canvas response that strictly follows Intercom format
    // Start with just the create ticket button
    const components = [];
    
    // Add spacing before the create ticket button
    components.push({
      type: 'spacer',
      size: 'm'
    });
    
    // Always show the create ticket button (no in-progress state in the UI)
    components.push({
      type: 'button',
      id: 'create_ticket',
      label: 'Create a Freshdesk Ticket',
      style: 'primary',
      action: {
        type: 'submit'
      }
    });
    
    // Add spacing between button and Recent Tickets header
    components.push({
      type: 'spacer',
      size: 'l'
    });
    
    // Add Recent Tickets section with white text
    components.push({
      type: 'text',
      id: 'recent_tickets_header',
      text: 'Recent Tickets',
      style: 'header',
      align: 'left',
      color: 'white'
    });
    
    // Add small spacing after Recent Tickets header
    components.push({
      type: 'spacer',
      size: 'xs'
    });
    
    // Add tickets if available, otherwise show 'no tickets' message
    if (recentTickets.length > 0) {
      // Add each ticket as a separate text component
      recentTickets.forEach((ticket, index) => {
        // Format the date
        const createdDate = new Date(ticket.created_at);
        
        // Format date to DD/MM/YYYY and time in IST with AM/PM
        const formattedDate = createdDate.toLocaleString('en-IN', {
          timeZone: 'Asia/Kolkata',
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: true
        });
        
        // Format the time to have uppercase AM/PM
        const [datePart, timePart] = formattedDate.split(', ');
        const [time, period] = timePart.split(' ');
        const formattedTime = `${time} ${period.toUpperCase()}`;
        
        // Truncate subject if it's longer than 40 characters
        let displaySubject = ticket.subject;
        if (displaySubject.length > 40) {
          displaySubject = displaySubject.substring(0, 40) + '...';
        }
        
        // Create a text component with ticket ID and truncated subject
        components.push({
          type: 'text',
          id: `ticket_${ticket.id}`,
          text: `[#${ticket.id} - ${displaySubject}](${FRESHDESK_DOMAIN}/a/tickets/${ticket.id})`,
          style: 'muted'
        });
        
        // Add date on a new line
        components.push({
          type: 'text',
          id: `ticket_date_${ticket.id}`,
          text: `${datePart}, ${formattedTime}`,
          style: 'muted',
          size: 'small'
        });
        
        // Add a small spacer after each ticket for better separation
        components.push({
          type: 'spacer',
          size: 'xs'
        });
      });
    } else {
      // No tickets found
      components.push({
        type: 'text',
        id: 'no_tickets',
        text: 'No recent tickets'
      });
    }
    
    // Create the response object with the exact structure Intercom expects
    const response = {
      canvas: {
        content: {
          components: components
        }
      }
    };
    
    console.log('Sending initial response to Intercom');
    res.json(response);
  } catch (error) {
    console.error('Error processing Intercom context:', error);
    // Return an error response
    res.json({
      canvas: {
        content: {
          components: [
            {
              type: 'text',
              id: 'error',
              text: 'Error loading Freshdesk integration. Please try again.',
              align: 'center',
              style: 'header'
            }
          ]
        }
      }
    });
  }
});

// Serve static files (React build) if the build directory exists
if (require('fs').existsSync(path.join(__dirname, 'build'))) {
  app.use(express.static(path.join(__dirname, 'build')));
  
  // Catch-all handler for UI routes only
  app.get('/ui/*', (req, res) => {
    res.sendFile(path.join(__dirname, 'build', 'index.html'));
  });
}

// Freshdesk API Endpoints

// No mock data needed for production use - using real Freshdesk API

// Helper function to post a note to Intercom conversation
async function postIntercomNote(conversationId, noteBody) {
  try {
    console.log(`Posting note to Intercom conversation ${conversationId}`);
    const response = await axios.post(
      `${process.env.INTERCOM_API_URL}/conversations/${conversationId}/reply`,
      {
        message_type: 'note',
        type: 'admin',
        admin_id: parseInt(process.env.INTERCOM_ADMIN_ID, 10), // Admin ID from environment variable
        body: noteBody
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.INTERCOM_ACCESS_TOKEN}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('Intercom note posted successfully');
    return response.data;
  } catch (error) {
    console.error('Error posting note to Intercom:', error.response?.data || error.message);
    return null;
  }
}

// Helper function to make API calls with retry
async function fetchWithRetry(url, options = {}, retries = 3, initialDelay = 500) {
  let currentDelay = initialDelay;
  let attempts = 0;
  
  // Add default method if not specified
  options.method = options.method || 'GET';
  
  // Ensure headers object exists
  options.headers = options.headers || {};
  
  // Add Freshdesk API auth for all calls if needed
  if (!options.auth && url.includes(FRESHDESK_DOMAIN)) {
    options.auth = {
      username: FRESHDESK_API_KEY,
      password: FRESHDESK_PASSWORD
    };
  }
  
  // Configure axios options
  if (options.data) {
    options.headers['Content-Type'] = 'application/json';
  }
  
  while (attempts <= retries) {
    try {
      console.log(`Attempt ${attempts + 1} for ${url}`);
      const response = await axios({
        url,
        ...options,
        timeout: 10000 // 10 second timeout
      });
      return response;
    } catch (error) {
      attempts++;
      
      if (attempts > retries) {
        console.error(`All ${retries + 1} attempts failed for ${url}`);
        throw error;
      }
      
      console.log(`Attempt ${attempts} failed, retrying in ${currentDelay}ms...`);
      
      // Use a local variable to safely capture the current delay value
      const delayForThisAttempt = currentDelay;
      await new Promise(resolve => setTimeout(resolve, delayForThisAttempt));
      
      // Exponential backoff with jitter
      currentDelay = Math.min(currentDelay * 2, 10000) * (0.8 + Math.random() * 0.4);
    }
  }
}

// Helper functions for Intercom conversation are imported from conversation-helper.js

// Get mailboxes from Freshdesk
app.get('/api/freshdesk/mailboxes', async (req, res) => {
  try {
    console.log('Fetching mailboxes from Freshdesk...');
    
    const response = await fetchWithRetry(`${FRESHDESK_DOMAIN}/api/v2/email/mailboxes`, { method: 'GET' });
    
    console.log('Mailboxes response received');
    
    // Filter only the needed fields for each mailbox
    const mailboxes = response.data.map(mailbox => ({
      id: mailbox.id,
      name: mailbox.name,
      support_email: mailbox.support_email,
      product_id: mailbox.product_id
    }));
    
    res.json(mailboxes);
  } catch (error) {
    console.error('Error fetching mailboxes:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch mailboxes from Freshdesk', details: error.message });
  }
});

// Get recent tickets from Freshdesk
app.get('/api/freshdesk/recent-tickets', async (req, res) => {
  try {
    console.log('Fetching recent tickets from Freshdesk...');
    
    // Get customer email from query params or from app.locals
    const customerEmail = req.query.email || app.locals.intercomContext?.customerEmail;
    
    if (!customerEmail) {
      return res.status(400).json({ error: 'Customer email is required' });
    }
    
    // Fetch tickets from Freshdesk API
    const response = await fetchWithRetry(
      `${FRESHDESK_DOMAIN}/api/v2/tickets?email=${encodeURIComponent(customerEmail)}&order_by=created_at&order_type=desc&per_page=5`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Basic ' + Buffer.from(FRESHDESK_API_KEY + ':' + FRESHDESK_PASSWORD).toString('base64')
        }
      }
    );
    
    // Extract relevant ticket information
    const tickets = response.data.map(ticket => ({
      id: ticket.id,
      subject: ticket.subject,
      created_at: ticket.created_at
    }));
    
    res.json(tickets);
  } catch (error) {
    console.error('Error fetching recent tickets:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch recent tickets from Freshdesk', details: error.message });
  }
});

// Get ticket statuses from Freshdesk
app.get('/api/freshdesk/statuses', async (req, res) => {
  try {
    console.log('Fetching statuses from Freshdesk...');
    
    // First get the field ID for status
    const fieldsResponse = await fetchWithRetry(`${FRESHDESK_DOMAIN}/api/v2/admin/ticket_fields`, { method: 'GET' });
    
    // Find the status field
    const statusField = fieldsResponse.data.find(field => field.name === 'status');
    
    if (!statusField) {
      throw new Error('Status field not found');
    }
    
    console.log('Status field ID:', statusField.id);
    
    // Get the choices for the status field
    const statusChoicesResponse = await fetchWithRetry(`${FRESHDESK_DOMAIN}/api/v2/admin/ticket_fields/${statusField.id}`, { method: 'GET' });
    
    // Map the choices to a simpler format
    const statuses = statusChoicesResponse.data.choices.map(choice => ({
      id: choice.id,
      label: choice.label
    }));
    
    console.log('Status choices received');
    res.json(statuses);
  } catch (error) {
    console.error('Error fetching statuses:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch statuses from Freshdesk' });
  }
});

// Note: '/api/freshdesk/recent-tickets' endpoint is already defined above

// Get ticket priorities from Freshdesk
app.get('/api/freshdesk/priorities', async (req, res) => {
  try {
    console.log('Fetching priorities from Freshdesk...');
    
    // First get the field ID for priority
    const fieldsResponse = await fetchWithRetry(`${FRESHDESK_DOMAIN}/api/v2/admin/ticket_fields`, { method: 'GET' });
    
    // Find the priority field
    const priorityField = fieldsResponse.data.find(field => field.name === 'priority');
    
    if (!priorityField) {
      throw new Error('Priority field not found');
    }
    
    console.log('Priority field ID:', priorityField.id);
    
    // Get the choices for the priority field
    const priorityChoicesResponse = await fetchWithRetry(`${FRESHDESK_DOMAIN}/api/v2/admin/ticket_fields/${priorityField.id}`, { method: 'GET' });
    
    console.log('Priority choices received');
    // Return the priority choices
    res.json(priorityChoicesResponse.data.choices);
  } catch (error) {
    console.error('Error fetching priorities:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch priorities from Freshdesk' });
  }
});

// Create a ticket in Freshdesk
app.post('/api/freshdesk/create-ticket', async (req, res) => {
  console.log('Creating ticket in Freshdesk...');
  console.log('Request body:', req.body);
  
  try {
    // Extract ticket data from request body
    const { email, subject, description, status, priority, product_id } = req.body;
    
    // Get conversation ID from the request
    const conversationId = req.body.conversation_id || req.body.conversation?.id;
    
    // Validate required fields
    if (!email || !subject || !description || !product_id) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Prepare the base ticket data
    let ticketData = {
      email,
      subject,
      description,
      source: 2, // Web form
      product_id: parseInt(product_id, 10)
    };
    
    // Add optional fields if they exist
    if (status) ticketData.status = parseInt(status, 10);
    if (priority) ticketData.priority = parseInt(priority, 10);
    
    // Add conversation ID to ticket data
    if (conversationId) {
      ticketData._intercom_conversation_id = conversationId;
      
      try {
        console.log(`Adding conversation transcript for ID: ${conversationId}`);
        ticketData = await addConversationTranscriptToTicket(ticketData, conversationId);
      } catch (transcriptError) {
        console.error('Error adding conversation transcript:', transcriptError);
        // Continue with ticket creation even if transcript fails
      }

      // Add Intercom URL directly to the description in the exact format requested
      const intercomUrl = `${process.env.INTERCOM_INBOX_URL}/conversation/${conversationId}`;
      const urlSection = `Chat Transcript Added\n\nIntercom Conversation URL: ${intercomUrl}\n\n`;
      
      console.log('Adding Intercom URL to ticket description:', urlSection);
      
      // Add URL section at the beginning of the description
      if (ticketData.description && ticketData.description.includes('Chat Transcript Added')) {
        ticketData.description = ticketData.description.replace('Chat Transcript Added', urlSection.trim());
      } else {
        ticketData.description = urlSection + (ticketData.description || '');
      }
    }
    
    // Create ticket in Freshdesk
    console.log('Creating Freshdesk ticket with data:', JSON.stringify(ticketData, null, 2));
    const ticket = await createFreshdeskTicket(ticketData);
    console.log('Ticket created successfully:', JSON.stringify(ticket, null, 2));
    
    // Return success response without the success message
    res.json({
      success: true,
      ticket: ticket
    });
  } catch (error) {
    console.error('Error creating ticket:', error.response?.data || error.message);
    
    // Return error response
    res.status(500).json({
      error: 'Failed to create ticket',
      details: error.response?.data || error.message
    });
  }
});

// Handle Intercom Canvas form submissions
app.post('/api/submit', async (req, res) => {
  console.log('Received form submission from Intercom Canvas:', req.body);
  
  // Create a flag to track if response has been sent
  let responseSent = false;
  
  // Set a timeout to return to homepage before Intercom's 10-second timeout
  const timeoutId = setTimeout(async () => {
    if (!responseSent) {
      console.log('⏰ TIMEOUT: Forcing return to homepage before Intercom timeout occurs');
      responseSent = true;
      
      // Track this ticket as in-progress
      const email = req.body.contact?.email || req.body.customer?.email || app.locals.intercomContext?.customerEmail;
      if (email && req.body.component_id === 'submit_ticket_button') {
        ticketTracker.set(email, {
          inProgress: true,
          startedAt: new Date().toISOString()
        });
        console.log(`Tracked in-progress ticket for ${email}`);
      }
      
      // Create components array for normal homepage view
      const components = [
        {
          type: 'button',
          id: 'create_ticket',
          label: 'Create a Freshdesk Ticket',
          style: 'primary',
          action: {
            type: 'submit'
          }
        },
        {
          type: 'divider'
        },
        {
          type: 'text',
          id: 'recent_tickets_header',
          text: 'Recent Tickets',
          style: 'header'
        }
      ];
      
      // Try to get recent tickets
      try {
        if (email) {
          // Fetch recent tickets from Freshdesk API
          const ticketsResponse = await axios.get(`${FRESHDESK_DOMAIN}/api/v2/tickets?email=${encodeURIComponent(email)}&order_by=created_at&order_type=desc&per_page=5`, {
            auth: {
              username: FRESHDESK_API_KEY,
              password: FRESHDESK_PASSWORD
            },
            headers: {
              'Content-Type': 'application/json'
            }
          });
          
          if (ticketsResponse.data && ticketsResponse.data.length > 0) {
            // Process each ticket and add to components
            ticketsResponse.data.forEach(ticket => {
              // Format the date
              const ticketDate = new Date(ticket.created_at);
              
              // Format date to DD/MM/YYYY and time in IST with AM/PM
              const formattedTicketDate = ticketDate.toLocaleString('en-IN', {
                timeZone: 'Asia/Kolkata',
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                hour12: true
              });
              
              // Split into date and time parts
              const dateParts = formattedTicketDate.split(', ');
              const datePart = dateParts[0];
              const formattedTime = dateParts[1];
              
              // Truncate subject if too long
              let displaySubject = ticket.subject;
              if (displaySubject.length > 40) {
                displaySubject = displaySubject.substring(0, 40) + '...';
              }
              
              // Add ticket information as a text component
              components.push({
                type: 'text',
                id: `ticket_${ticket.id}`,
                text: `[#${ticket.id} - ${displaySubject}](${FRESHDESK_DOMAIN}/a/tickets/${ticket.id})`,
                style: 'muted'
              });
              
              // Add date on a new line
              components.push({
                type: 'text',
                id: `ticket_date_${ticket.id}`,
                text: `${datePart}, ${formattedTime}`,
                style: 'muted',
                size: 'small'
              });
              
              // Add a small spacer after each ticket for better separation
              components.push({
                type: 'spacer',
                size: 'xs'
              });
            });
          } else {
            // No tickets found
            components.push({
              type: 'text',
              id: 'no_tickets',
              text: 'No recent tickets',
              style: 'muted'
            });
          }
        } else {
          // No email available
          components.push({
            type: 'text',
            id: 'no_tickets',
            text: 'No recent tickets',
            style: 'muted'
          });
        }
      } catch (error) {
        console.error('Error fetching recent tickets on timeout:', error);
        components.push({
          type: 'text',
          id: 'no_tickets',
          text: 'No recent tickets',
          style: 'muted'
        });
      }
      
      // Return the standard homepage view with recent tickets
      res.json({
        canvas: {
          content: {
            components: components
          }
        }
      });
    }
  }, 9000); // Exactly 9 seconds - to ensure we return before Intercom's 10-second timeout
  
  try {
    // Helper function to safely send response and avoid duplicate responses
    const sendResponse = (responseData) => {
      if (!responseSent) {
        responseSent = true;
        clearTimeout(timeoutId);
        res.json(responseData);
      }
    };
    
    // Log the component ID for debugging
    console.log('Component ID:', req.body.component_id);
    
    // Get contact name from the request body
    const contactName = req.body.contact?.name || req.body.customer?.name || 'Contact';
    const defaultTitle = `Conversation from ${contactName}`;
    
    // Get customer email from the request body
    const customerEmail = req.body.contact?.email || req.body.customer?.email || '';
    
    // Get default description from conversation or use empty string
    const defaultDescription = req.body.conversation?.source?.body || '';
    
    // Log the values being used
    console.log('Using customer email:', customerEmail);
    console.log('Using default title:', defaultTitle);
    console.log('Using default description:', defaultDescription);
    
    // Store in app.locals for potential future use
    app.locals.intercomContext = {
      customerEmail,
      defaultTitle,
      defaultDescription
    };
    
    if (req.body.component_id === 'create_ticket') {
      // Initial button click - show the form
      console.log('Create ticket button clicked, showing form...');
      
      // Fetch Freshdesk data for the form
      let mailboxes = [];
      let statusField = null;
      let priorityField = null;
      let statusChoices = [];
      let priorityChoices = [];
      
      try {
        console.log('Fetching mailboxes from Freshdesk...');
        // Fetch mailboxes with retry
        const mailboxesResponse = await fetchWithRetry(`${FRESHDESK_DOMAIN}/api/v2/email/mailboxes`, { method: 'GET' });
        
        console.log('Mailboxes response:', mailboxesResponse.data);
        mailboxes = mailboxesResponse.data;
        
        // Fetch ticket fields with retry
        console.log('Fetching ticket fields from Freshdesk...');
        const fieldsResponse = await fetchWithRetry(`${FRESHDESK_DOMAIN}/api/v2/admin/ticket_fields`, { method: 'GET' });
        
        // Find status field
        statusField = fieldsResponse.data.find(field => field.name === 'status');
        if (statusField) {
          console.log('Found status field with ID:', statusField.id);
          const statusChoicesResponse = await fetchWithRetry(`${FRESHDESK_DOMAIN}/api/v2/admin/ticket_fields/${statusField.id}`, { method: 'GET' });
          
          statusChoices = statusChoicesResponse.data.choices;
          console.log('Status choices:', statusChoices);
        }
        
        // Find priority field
        priorityField = fieldsResponse.data.find(field => field.name === 'priority');
        if (priorityField) {
          console.log('Found priority field with ID:', priorityField.id);
          const priorityChoicesResponse = await fetchWithRetry(`${FRESHDESK_DOMAIN}/api/v2/admin/ticket_fields/${priorityField.id}`, { method: 'GET' });
          
          priorityChoices = priorityChoicesResponse.data.choices;
          console.log('Priority choices:', priorityChoices);
        }
      } catch (error) {
        console.error('Error fetching Freshdesk data:', error.message);
        // Return an error response if we couldn't fetch the required data
        return res.status(500).json({
          canvas: {
            content: {
              components: [
                {
                  type: 'text',
                  text: 'Error',
                  style: 'header'
                },
                {
                  type: 'text',
                  text: 'Failed to load Freshdesk data. Please try again in a moment.',
                  style: 'error'
                },
                {
                  type: 'button',
                  id: 'retry_button',
                  label: 'Retry',
                  style: 'primary',
                  action: {
                    type: 'submit'
                  }
                }
              ]
            }
          }
        });
      }
      
      // Following strictly the format in the Intercom documentation
      // Set default values
      const defaultDescription = 'Chat Transcript Added';
      
      // We'll add inline validation rules directly to the email field

      const formComponents = [
        {
          type: 'text',
          text: 'Create a new Freshdesk ticket',
          style: 'header'
        },
        {
          type: 'input',
          id: 'email',
          label: 'Email',
          value: customerEmail || '',
          placeholder: 'Enter email address',
          validation_rules: {
            required: { error: 'Email is required' },
            format: { type: 'email_address', error: 'Please enter a valid email address' }
          }
        },
        {
          type: 'input',
          id: 'subject',
          label: 'Subject',
          value: defaultTitle || 'New Ticket'
        },
        {
          type: 'textarea',
          id: 'description',
          label: 'Description',
          value: defaultDescription
        }
      ];

      // Add mailboxes dropdown if available
      if (mailboxes && mailboxes.length > 0) {
        // Filter out inactive mailboxes
        const activeMailboxes = mailboxes.filter(mailbox => mailbox.active === true);
        
        if (activeMailboxes.length > 0) {
          // Find default mailbox (first one with default_reply_email: true, or first active one)
          const defaultMailbox = activeMailboxes.find(mailbox => mailbox.default_reply_email === true) || activeMailboxes[0];
          
          formComponents.push({
            type: 'dropdown',
            id: 'product_id',
            label: 'Configure Email',
            value: defaultMailbox ? `product_${defaultMailbox.product_id}` : '',
            options: activeMailboxes.map(mailbox => ({
              type: 'option',
              id: `product_${mailbox.product_id}`,
              text: `${mailbox.name} (${mailbox.support_email})`,
              value: mailbox.product_id.toString()
            }))
          });
        }
      }

      // Add status dropdown if available
      if (statusChoices.length > 0) {
        // Find the default status (Open or first available)
        const defaultStatus = statusChoices.find(s => s.label.toLowerCase() === 'open') || statusChoices[0];
        const statusOptions = statusChoices.map(status => ({
          type: 'option',
          id: `status_${status.id}`,
          text: status.label,
          value: status.id.toString()
        }));
        
        formComponents.push({
          type: 'dropdown',
          id: 'status',
          label: 'Status',
          value: defaultStatus ? `status_${defaultStatus.id}` : '',
          options: statusOptions
        });
      }

      // Add priority dropdown if available
      if (priorityChoices.length > 0) {
        // Find the default priority (Medium or first available)
        const defaultPriority = priorityChoices.find(p => p.label.toLowerCase() === 'medium') || priorityChoices[0];
        const priorityOptions = priorityChoices.map(priority => ({
          type: 'option',
          id: `priority_${priority.value}`,
          text: priority.label,
          value: priority.value.toString()
        }));
        
        formComponents.push({
          type: 'dropdown',
          id: 'priority',
          label: 'Priority',
          value: defaultPriority ? `priority_${defaultPriority.value}` : '',
          options: priorityOptions
        });
      }

      // Add action buttons
      formComponents.push(
        {
          type: 'button',
          id: 'submit_ticket_button',
          label: 'Create Ticket',
          style: 'primary',
          disabled: false, // Ensure it's enabled by default
          action: {
            type: 'submit'
          }
        },
        {
          type: 'button',
          id: 'cancel',
          label: 'Cancel',
          style: 'secondary',
          disabled: false, // Ensure it's enabled by default
          action: {
            type: 'submit'
          }
        }
      );

      // Find the selected status and priority values
      const selectedStatus = statusChoices.find(s => s.label.toLowerCase() === 'open') || statusChoices[0];
      const selectedPriority = priorityChoices.find(p => p.label.toLowerCase() === 'medium') || priorityChoices[0];

      // Return the form components with selected values and validation
      sendResponse({
        canvas: {
          content: {
            components: formComponents,
            // Set the selected values in the response
            values: {
              status: selectedStatus ? `status_${selectedStatus.id}` : '',
              priority: selectedPriority ? `priority_${selectedPriority.value}` : ''
            },
            // Add validation rules to ensure the submit button is disabled for invalid forms
            validation_errors: {
              // Make sure email is required for the form to be valid
              email: customerEmail ? '' : 'Email is required'
            }
          }
        }
      });
      return;
    } else if (req.body.component_id === 'submit_ticket_button') {
      // Extract values from the form submission
      // in Intercom's format, form values are stored at req.body.input_values
      const inputValues = req.body.input_values || {};
      console.log('Form input values:', inputValues);
      
      // -------------------------------------------------------------
      // VALIDATE REQUIRED FIELDS - Email and Subject
      // -------------------------------------------------------------
      
      // Check if any required fields are empty
      const isEmailEmpty = !inputValues.email || inputValues.email.trim() === '';
      const isSubjectEmpty = !inputValues.subject || inputValues.subject.trim() === '';
      
      // If either required field is empty, show validation errors
      if (isEmailEmpty || isSubjectEmpty) {
        console.log(`VALIDATION ERROR: Required fields missing - Email: ${isEmailEmpty}, Subject: ${isSubjectEmpty}`);
        
        // Recreate the form showing the error
        // Get required data for dropdowns
        let activeMailboxes = [];
        let statusChoices = [];
        let priorityChoices = [];
        
        try {
          // Get mailboxes for the form
          const mailboxesResponse = await fetchWithRetry(`${FRESHDESK_DOMAIN}/api/v2/email/mailboxes`, { method: 'GET' });
          activeMailboxes = mailboxesResponse.data.filter(mailbox => mailbox.active === true);
          
          // Get ticket field data
          const fieldsResponse = await fetchWithRetry(`${FRESHDESK_DOMAIN}/api/v2/admin/ticket_fields`, { method: 'GET' });
          
          // Get status field
          const statusField = fieldsResponse.data.find(field => field.name === 'status');
          if (statusField) {
            const statusChoicesResponse = await fetchWithRetry(`${FRESHDESK_DOMAIN}/api/v2/admin/ticket_fields/${statusField.id}`, { method: 'GET' });
            statusChoices = statusChoicesResponse.data.choices;
          }
          
          // Get priority field
          const priorityField = fieldsResponse.data.find(field => field.name === 'priority');
          if (priorityField) {
            const priorityChoicesResponse = await fetchWithRetry(`${FRESHDESK_DOMAIN}/api/v2/admin/ticket_fields/${priorityField.id}`, { method: 'GET' });
            priorityChoices = priorityChoicesResponse.data.choices;
          }
        } catch (error) {
          console.error('Error fetching form data:', error.message);
        }
        
        // Build the error form
        const errorForm = [
          {
            type: 'text',
            text: isEmailEmpty && isSubjectEmpty ? 'Email and Subject are required' : 
                  isEmailEmpty ? 'Email is required' : 'Subject is required',
            style: 'error'
          },
          {
            type: 'input',
            id: 'email',
            label: 'Email',
            value: isEmailEmpty ? '' : inputValues.email,
            placeholder: 'Enter email address',
            error: isEmailEmpty ? 'Email is required' : undefined,
            validation_rules: {
              required: { error: 'Email is required' },
              format: { type: 'email_address', error: 'Please enter a valid email address' }
            }
          },
          {
            type: 'input',
            id: 'subject',
            label: 'Subject',
            value: isSubjectEmpty ? '' : (inputValues.subject || defaultTitle || 'New Ticket'),
            error: isSubjectEmpty ? 'Subject is required' : undefined,
            validation_rules: {
              required: { error: 'Subject is required' }
            }
          },
          {
            type: 'textarea',
            id: 'description',
            label: 'Description',
            value: inputValues.description || 'Chat Transcript Added'
          }
        ];
        
        // Add product dropdown
        if (activeMailboxes.length > 0) {
          errorForm.push({
            type: 'dropdown',
            id: 'product_id',
            label: 'Configure Email',
            value: inputValues.product_id || `product_${activeMailboxes[0].product_id}`,
            options: activeMailboxes.map(mailbox => ({
              type: 'option',
              id: `product_${mailbox.product_id}`,
              text: `${mailbox.name} (${mailbox.support_email})`,
              value: mailbox.product_id.toString()
            }))
          });
        }
        
        // Add status dropdown
        if (statusChoices.length > 0) {
          errorForm.push({
            type: 'dropdown',
            id: 'status',
            label: 'Status',
            value: inputValues.status || 'status_2',
            options: statusChoices.map(status => ({
              type: 'option',
              id: `status_${status.id}`,
              text: status.label,
              value: status.id.toString()
            }))
          });
        }
        
        // Add priority dropdown
        if (priorityChoices.length > 0) {
          errorForm.push({
            type: 'dropdown',
            id: 'priority',
            label: 'Priority',
            value: inputValues.priority || 'priority_2',
            options: priorityChoices.map(priority => ({
              type: 'option',
              id: `priority_${priority.value}`,
              text: priority.label,
              value: priority.value.toString()
            }))
          });
        }
        
        // Add action buttons
        errorForm.push(
          {
            type: 'button',
            id: 'submit_ticket_button',
            label: 'Create Ticket',
            style: 'primary',
            action: {
              type: 'submit'
            }
          },
          {
            type: 'button',
            id: 'cancel',
            label: 'Cancel',
            style: 'secondary',
            action: {
              type: 'submit'
            }
          }
        );
        
        // Return the error form with explicit validation errors
        sendResponse({
          canvas: {
            content: {
              components: errorForm,
              validation_errors: {
                email: isEmailEmpty ? 'Email is required' : undefined,
                subject: isSubjectEmpty ? 'Subject is required' : undefined
              }
            }
          }
        });
        return;
      }
      
      // If we got past the validation, proceed with normal flow
      const userProvidedEmail = inputValues.email.trim();
      const userProvidedSubject = inputValues.subject.trim();
      const email = userProvidedEmail;
      const subject = userProvidedSubject;
      let description = inputValues.description || defaultDescription || '';
      
      // Extract product_id directly from the product ID number
      let product_id = '';
      if (inputValues.product_id) {
        // Direct approach - extract just the numbers at the end
        product_id = inputValues.product_id.replace('product_', '');
        console.log('Extracted product_id:', product_id);
      }
      
      // Extract status directly from the status number
      let status = '';
      if (inputValues.status) {
        // Direct approach - extract just the numbers at the end
        status = inputValues.status.replace('status_', '');
        console.log('Extracted status:', status);
      }
      
      // Extract priority directly from the priority number
      let priority = '';
      if (inputValues.priority) {
        // Direct approach - extract just the numbers at the end
        priority = inputValues.priority.replace('priority_', '');
        console.log('Extracted priority:', priority);
      }
      
      console.log('Extracted values for ticket creation:', {
        email,
        subject,
        description,
        product_id,
        status,
        priority
      });
      
      // Additional validation check (this should never be reached due to the earlier check)
      if (!email || !subject) {
        console.error(`Required fields missing: Email: ${!email}, Subject: ${!subject}`);
        
        // Recreate the form with the error message, preserving the entered values
        // First create the basic form components
        const errorFormComponents = [
          {
            type: 'text',
            text: 'Create a new Freshdesk ticket',
            style: 'header'
          },
          {
            type: 'input',
            id: 'email',
            label: 'Email',
            value: '',  // Keep empty to show the validation error
            placeholder: 'Enter email address',
            validation_rules: {
              required: { error: 'Email is required' },
              format: { type: 'email_address', error: 'Please enter a valid email address' }
            },
            error: 'Email is required'  // Highlight in red
          },
          {
            type: 'input',
            id: 'subject',
            label: 'Subject',
            value: subject || defaultTitle || 'New Ticket'
          },
          {
            type: 'textarea',
            id: 'description',
            label: 'Description',
            value: description || defaultDescription || ''
          }
        ];
        
        // Add the same product dropdown
        if (inputValues.product_id) {
          errorFormComponents.push({
            type: 'dropdown',
            id: 'product_id',
            label: 'Configure Email',
            value: inputValues.product_id
          });
        }
        
        // Add the same status dropdown
        if (inputValues.status) {
          errorFormComponents.push({
            type: 'dropdown',
            id: 'status',
            label: 'Status',
            value: inputValues.status
          });
        }
        
        // Add the same priority dropdown
        if (inputValues.priority) {
          errorFormComponents.push({
            type: 'dropdown',
            id: 'priority',
            label: 'Priority',
            value: inputValues.priority
          });
        }
        
        // Add the action buttons
        errorFormComponents.push(
          {
            type: 'button',
            id: 'submit_ticket_button',
            label: 'Create Ticket',
            style: 'primary',
            disabled: false,
            action: {
              type: 'submit'
            }
          },
          {
            type: 'button',
            id: 'cancel',
            label: 'Cancel',
            style: 'secondary',
            disabled: false,
            action: {
              type: 'submit'
            }
          }
        );
        
        sendResponse({
          canvas: {
            content: {
              components: errorFormComponents,
              validation_errors: {
                email: 'Email is required'
              }
            }
          }
        });
        return;
      }
      
      // Validate other required fields
      if (!subject || !description || !product_id) {
        console.error('Missing required fields in form submission');
        sendResponse({
          canvas: {
            content: {
              components: [
                {
                  type: 'text',
                  text: 'Please fill in all required fields',
                  style: 'error'
                },
                {
                  type: 'button',
                  id: 'try_again',
                  label: 'Try Again',
                  style: 'primary',
                  action: {
                    type: 'reload'
                  }
                }
              ]
            }
          }
        });
        return;
      }
      
      // Store conversation ID for later use, even if we timeout
      const conversationId = req.body.conversation_id || req.body.conversation?.id;
      if (conversationId) {
        console.log(`Found conversation ID: ${conversationId}, will be used for notification`);
      }
      
      // Fetch current recent tickets to display while ticket creation continues in background
      let recentTickets = [];
      try {
        // Get the user's email from the ticket data
        const userEmail = email;
        console.log(`Fetching recent tickets for email: ${userEmail}`);
        
        // Fetch recent tickets from Freshdesk API
        const recentTicketsResponse = await axios.get(`${FRESHDESK_DOMAIN}/api/v2/tickets?email=${encodeURIComponent(userEmail)}&order_by=created_at&order_type=desc&per_page=5`, {
          auth: {
            username: FRESHDESK_API_KEY,
            password: FRESHDESK_PASSWORD
          },
          headers: {
            'Content-Type': 'application/json'
          }
        });
        
        if (recentTicketsResponse.data && recentTicketsResponse.data.length > 0) {
          recentTickets = recentTicketsResponse.data;
        }
      } catch (error) {
        console.error('Error fetching recent tickets:', error.response?.data || error.message);
      }
      
      // Create components for immediate response
      const components = [
        {
          type: 'button',
          id: 'create_ticket',
          label: 'Create a Freshdesk Ticket',
          style: 'primary',
          action: {
            type: 'submit'
          }
        },
        {
          type: 'divider'
        },
        {
          type: 'text',
          id: 'recent_tickets_header',
          text: 'Recent Tickets',
          style: 'header'
        }
      ];
      
      // Process recent tickets to display
      if (recentTickets.length > 0) {
        recentTickets.forEach(ticket => {
          // Format the date
          const ticketDate = new Date(ticket.created_at);
          
          // Format date to DD/MM/YYYY and time in IST with AM/PM
          const formattedTicketDate = ticketDate.toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
          });
          
          // Split into date and time parts
          const dateParts = formattedTicketDate.split(', ');
          const datePart = dateParts[0];
          const formattedTime = dateParts[1];
          
          // Truncate subject if too long
          let displaySubject = ticket.subject;
          if (displaySubject.length > 40) {
            displaySubject = displaySubject.substring(0, 40) + '...';
          }
          
          // Add ticket information as a text component
          components.push({
            type: 'text',
            id: `ticket_${ticket.id}`,
            text: `[#${ticket.id} - ${displaySubject}](${FRESHDESK_DOMAIN}/a/tickets/${ticket.id})`,
            style: 'muted'
          });
          
          // Add date on a new line
          components.push({
            type: 'text',
            id: `ticket_date_${ticket.id}`,
            text: `${datePart}, ${formattedTime}`,
            style: 'muted',
            size: 'small'
          });
          
          // Add a small spacer after each ticket for better separation
          components.push({
            type: 'spacer',
            size: 'xs'
          });
        });
      } else {
        // No tickets found
        components.push({
          type: 'text',
          id: 'no_tickets',
          text: 'No recent tickets',
          style: 'muted'
        });
      }
      
      // No status message needed - removed as requested
      
      // Mark that ticket creation is in progress for this email
      if (email) {
        ticketTracker.set(email, {
          inProgress: true,
          startedAt: new Date().toISOString()
        });
        console.log(`Marked ticket creation as in-progress for ${email}`);
      }
      
      // Send immediate response with homepage view
      sendResponse({
        canvas: {
          content: {
            components: components
          }
        }
      });
      
      // Process the ticket creation in the background
      setTimeout(async () => {
        try {
          let transcriptHtml = '';
          
          if (conversationId) {
            console.log(`Processing in background: Found conversation ID: ${conversationId}, fetching transcript...`);
            try {
              // Fetch conversation details from Intercom
              const conversation = await fetchIntercomConversation(conversationId);
              
              // Format the conversation as HTML
              transcriptHtml = formatConversationAsHtml(conversation);
              console.log('Successfully generated conversation transcript');
              
              // Add the transcript to the description
              if (transcriptHtml) {
                description += '\n\n' + transcriptHtml;
              }
            } catch (error) {
              console.error('Error fetching or formatting conversation:', error);
              // Continue with ticket creation even if transcript fails
            }
          }
          
          // Prepare ticket data
          const ticketData = {
            email,
            subject,
            description,
            source: 2, // Web form
            product_id: parseInt(product_id, 10)
          };
          
          // Add optional fields if provided
          if (status) ticketData.status = parseInt(status, 10);
          if (priority) ticketData.priority = parseInt(priority, 10);
          
          // Add conversation transcript to ticket data if conversation ID is available
          let ticketDataWithTranscript = ticketData;
          if (conversationId) {
            console.log('Adding conversation transcript to ticket...');
            ticketDataWithTranscript = await addConversationTranscriptToTicket(ticketData, conversationId);
          }
          
          // Create ticket in Freshdesk
          const ticketResponse = await createFreshdeskTicket(ticketDataWithTranscript);
          console.log('Background processing: Ticket created successfully:', ticketResponse);
          
          // Get ticket URL for the console (for reference)
          const ticketUrl = `${FRESHDESK_DOMAIN}/a/tickets/${ticketResponse.id}`;
          console.log(`\u2705 Background processing: Ticket created successfully: ${ticketUrl}`);
          
          // Post a note to the Intercom conversation with the Freshdesk ticket URL
          if (conversationId) {
            const noteBody = `Freshdesk Ticket creation successful.\nTicket URL: ${ticketUrl}`;
            await postIntercomNote(conversationId, noteBody);
          }
          
          // Store the completed ticket information for future Canvas loads
          if (email) {
            ticketTracker.set(email, {
              inProgress: false,
              ticketId: ticketResponse.id,
              createdAt: new Date().toISOString()
            });
            console.log(`Background processing: Tracked completed ticket for ${email}: ${ticketResponse.id}`);
          }
        } catch (error) {
          console.error('Background processing: Error creating ticket:', error.response?.data || error.message);
          
          // Post a note to the Intercom conversation about the failure
          if (conversationId) {
            const errorMessage = error.response?.data?.message || error.message;
            const noteBody = `Freshdesk Ticket creation failed. Contact Admin.\nError: ${errorMessage}`;
            await postIntercomNote(conversationId, noteBody);
          }
          
          // Update the ticket tracker to show the creation failed
          if (email) {
            ticketTracker.set(email, {
              inProgress: false,
              error: error.response?.data?.message || error.message,
              createdAt: new Date().toISOString()
            });
          }
        }
      }, 0);
      
      // Return from the route handler since we've already sent the response
      return;
    } else if (req.body.component_id === 'cancel') {
      // Handle cancel button - don't show 'Ticket creation cancelled' message
      // Instead, fetch recent tickets and display them
      try {
        // Get customer email from the request body or app.locals
        const customerEmail = req.body.contact?.email || req.body.customer?.email || app.locals.intercomContext?.customerEmail;
        
        // Create components array for the response
        const components = [
          {
            type: 'button',
            id: 'create_ticket',
            label: 'Create a Ticket',
            style: 'primary',
            action: {
              type: 'submit'
            }
          },
          {
            type: 'divider'
          },
          {
            type: 'text',
            id: 'recent_tickets_header',
            text: 'Recent Tickets',
            style: 'header'
          }
        ];
        
        // If we have a customer email, fetch their recent tickets
        if (customerEmail) {
          try {
            // Fetch tickets from Freshdesk API
            const response = await fetchWithRetry(
              `${FRESHDESK_DOMAIN}/api/v2/tickets?email=${encodeURIComponent(customerEmail)}&order_by=created_at&order_type=desc&per_page=5`,
              {
                method: 'GET',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': 'Basic ' + Buffer.from(FRESHDESK_API_KEY + ':' + FRESHDESK_PASSWORD).toString('base64')
                }
              }
            );
            
            // If tickets were found, add them to the components
            if (response.data && response.data.length > 0) {
              response.data.forEach(ticket => {
                // Format the date
                const ticketDate = new Date(ticket.created_at);
                
                // Format date to DD/MM/YYYY and time in IST with AM/PM
                const formattedTicketDate = ticketDate.toLocaleString('en-IN', {
                  timeZone: 'Asia/Kolkata',
                  day: '2-digit',
                  month: '2-digit',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: true
                });
                
                // Split into date and time parts
                const parts = formattedTicketDate.split(', ');
                const datePart = parts[0];
                const formattedTime = parts[1];
                
                // Truncate subject if it's longer than 40 characters
                let displaySubject = ticket.subject;
                if (displaySubject.length > 40) {
                  displaySubject = displaySubject.substring(0, 40) + '...';
                }
                
                // Add ticket information as a text component
                components.push({
                  type: 'text',
                  id: `ticket_${ticket.id}`,
                  text: `[#${ticket.id} - ${displaySubject}](${FRESHDESK_DOMAIN}/a/tickets/${ticket.id})`,
                  style: 'muted'
                });
                
                // Add date on a new line
                components.push({
                  type: 'text',
                  id: `ticket_date_${ticket.id}`,
                  text: `${datePart}, ${formattedTime}`,
                  style: 'muted',
                  size: 'small'
                });
                
                // Add a small spacer after each ticket for better separation
                components.push({
                  type: 'spacer',
                  size: 'xs'
                });
              });
            } else {
              // No tickets found
              components.push({
                type: 'text',
                id: 'no_tickets',
                text: 'No recent tickets',
                style: 'muted'
              });
            }
          } catch (error) {
            console.error('Error fetching recent tickets:', error.response?.data || error.message);
            // No tickets found
            components.push({
              type: 'text',
              id: 'no_tickets',
              text: 'No recent tickets',
              style: 'muted'
            });
          }
        } else {
          // No customer email available
          components.push({
            type: 'text',
            id: 'no_tickets',
            text: 'No recent tickets',
            style: 'muted'
          });
        }
        
        // Return the response with the components
        sendResponse({
          canvas: {
            content: {
              components: components
            }
          }
        });
        return;
      } catch (error) {
        console.error('Error handling cancel button:', error);
        // Return a simple response if there's an error
        sendResponse({
          canvas: {
            content: {
              components: [
                {
                  type: 'button',
                  id: 'create_ticket',
                  label: 'Create a Ticket',
                  style: 'primary',
                  action: {
                    type: 'submit'
                  }
                },
                {
                  type: 'divider'
                },
                {
                  type: 'text',
                  id: 'recent_tickets_header',
                  text: 'Recent Tickets',
                  style: 'header'
                },
                {
                  type: 'text',
                  id: 'no_tickets',
                  text: 'No recent tickets',
                  style: 'muted'
                }
              ]
            }
          }
        });
        return;
      }
    } else if (req.body.component_id === 'refresh_status' || req.body.component_id === 'retry_button') {
      // Handle retry button click - redirect back to create_ticket
      return res.json({
        canvas: {
          content: {
            components: [
              {
                type: 'button',
                id: 'create_ticket',
                label: 'Create a Freshdesk Ticket',
                style: 'primary',
                action: {
                  type: 'submit'
                }
              },
              {
                type: 'divider'
              },
              {
                type: 'text',
                id: 'recent_tickets_header',
                text: 'Recent Tickets',
                style: 'header'
              },
              {
                type: 'text',
                id: 'no_tickets',
                text: 'No recent tickets',
                style: 'muted'
              }
            ]
          }
        }
      });
    } else {
      // Default fallback response for any other button clicks
      return res.json({
        canvas: {
          content: {
            components: [
              {
                type: 'button',
                id: 'create_ticket',
                label: 'Create a Freshdesk Ticket',
                style: 'primary',
                action: {
                  type: 'submit'
                }
              },
              {
                type: 'divider'
              },
              {
                type: 'text',
                id: 'recent_tickets_header',
                text: 'Recent Tickets',
                style: 'header'
              },
              {
                type: 'text',
                id: 'no_tickets',
                text: 'No recent tickets',
                style: 'muted'
              }
            ]
          }
        }
      });
    }
  } catch (error) {
    console.error('Error processing form submission:', error);
    
    sendResponse({
      canvas: {
        content: {
          components: [
            {
              type: 'text',
              text: `An error occurred: ${error.message}`,
              style: 'error'
            },
            {
              type: 'button',
              id: 'try_again',
              label: 'Try Again',
              style: 'primary',
              action: {
                type: 'reload'
              }
            },
            {
              type: 'divider'
            },
            {
              type: 'text',
              id: 'recent_tickets_header',
              text: 'Recent Tickets',
              style: 'header'
            },
            {
              type: 'text',
              id: 'no_tickets',
              text: 'No recent tickets',
              style: 'muted'
            }
          ]
        }
      }
    });
    return;
  }
});

// We already have an initialize endpoint defined above, so this one is removed

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
